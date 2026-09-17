import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

type SupabaseOutboxRow = {
  id: string;
  idempotency_key: string;
  event_id: string;
  event_name: 'ViewContent' | 'Lead' | 'Schedule';
  event_time: number;
  payload: Record<string, unknown>;
  status: string;
  delivery_lane: 'test' | 'live';
  lead_id: string | null;
  visitor_key: string | null;
  ads_consent_required: boolean;
};

/**
 * Drena meta_capi_outbox (Supabase) → cola Nest local, sin depender de tráfico web.
 * Lock temporal en SQLite; recupera locks caducados tras reinicio.
 */
@Injectable()
export class SupabaseDrainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupabaseDrainService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = false;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private readonly ownerId = randomUUID();

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly events: EventsService,
    private readonly meta: MetaCapiService,
  ) {}

  get status() {
    return {
      enabled: this.enabled,
      ticking: this.running,
      last_tick_at: this.lastTickAt,
      last_tick_error: this.lastTickError,
      poll_ms: Number(this.config.get('SUPABASE_DRAIN_POLL_MS')) || 15000,
      configured: this.isConfigured(),
    };
  }

  private isConfigured() {
    return Boolean(this.supabaseUrl() && this.serviceRoleKey());
  }

  private supabaseUrl() {
    return String(this.config.get<string>('SUPABASE_URL') || '')
      .trim()
      .replace(/\/$/, '');
  }

  private serviceRoleKey() {
    return String(
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
    ).trim();
  }

  onModuleInit() {
    const raw = String(
      this.config.get<string>('SUPABASE_DRAIN_ENABLED') || '',
    )
      .trim()
      .toLowerCase();
    const drainOn = raw === 'true' || raw === '1';

    if (!drainOn) {
      this.logger.log(
        'Supabase drain deshabilitado (SUPABASE_DRAIN_ENABLED no es true)',
      );
      return;
    }

    if (!this.isConfigured()) {
      throw new Error(
        'SUPABASE_DRAIN_ENABLED=true requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY',
      );
    }

    this.enabled = true;
    const poll = Number(this.config.get('SUPABASE_DRAIN_POLL_MS')) || 15000;
    this.timer = setInterval(() => void this.tick(), poll);
    this.firstTick = setTimeout(() => void this.tick(), 2500);
    this.logger.log(`Supabase drain activo (poll=${poll}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTick) clearTimeout(this.firstTick);
    this.timer = null;
    this.firstTick = null;
    this.db.releaseLock('supabase_drain', this.ownerId);
  }

  async tick() {
    if (this.running || !this.enabled) return;
    this.running = true;
    const ttl = Number(this.config.get('SUPABASE_DRAIN_LOCK_TTL_MS')) || 60000;
    const got = this.db.tryAcquireLock('supabase_drain', this.ownerId, ttl);
    if (!got) {
      this.running = false;
      return;
    }

    try {
      await this.recoverMissingLeadOutbox();
      await this.drainConsentLedger();
      const batch = Number(this.config.get('SUPABASE_DRAIN_BATCH_SIZE')) || 20;
      const lane = this.meta.mode === 'test' ? 'test' : 'live';
      const rows = await this.fetchPending(batch, lane);
      let forwarded = 0;
      let cancelled = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of rows) {
        // Defensa: solo pending. review_hold y terminales no se envían ni se mutan.
        if (row.status !== 'pending') {
          skipped += 1;
          this.logger.log(
            `drain skip non_pending status=${row.status} event_id=${row.event_id}`,
          );
          continue;
        }
        const outcome = await this.forwardRow(row);
        if (outcome === 'forwarded') forwarded += 1;
        else if (outcome === 'cancelled') cancelled += 1;
        else failed += 1;
      }

      this.lastTickAt = new Date().toISOString();
      this.lastTickError = null;
      if (forwarded || cancelled || failed || skipped) {
        this.logger.log(
          `drain forwarded=${forwarded} cancelled=${cancelled} failed=${failed} skipped=${skipped}`,
        );
      }
    } catch (error) {
      this.lastTickError =
        error instanceof Error ? error.message.slice(0, 200) : 'drain_failed';
      this.logger.error(
        'supabase drain failed',
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.db.releaseLock('supabase_drain', this.ownerId);
      this.running = false;
    }
  }

  private async supabaseFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return fetch(`${this.supabaseUrl()}${path}`, {
      ...init,
      headers: {
        apikey: this.serviceRoleKey(),
        Authorization: `Bearer ${this.serviceRoleKey()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init?.headers || {}),
      },
    });
  }

  private async drainConsentLedger() {
    const qs = new URLSearchParams({
      select: 'id,visitor_key,lead_id,ads_consent,consent_version,nest_status,nest_attempts',
      nest_status: 'in.(pending,failed)',
      order: 'consent_version.asc',
      limit: '20',
    });
    const res = await this.supabaseFetch(`/rest/v1/meta_ads_consent_ledger?${qs}`);
    if (!res.ok) {
      if (res.status !== 404) {
        this.logger.warn(`consent_ledger_fetch http=${res.status}`);
      }
      return;
    }
    const rows = (await res.json()) as Array<{
      id: string;
      visitor_key: string | null;
      lead_id: string | null;
      ads_consent: boolean;
      consent_version: number;
    }>;

    for (const row of rows) {
      const version = Number(row.consent_version);
      try {
        if (row.ads_consent) {
          if (row.lead_id) this.db.grantConsent('lead', row.lead_id, version);
          if (row.visitor_key) {
            this.db.grantConsent('visitor', row.visitor_key, version);
          }
        } else {
          if (row.lead_id) this.db.revokeConsent('lead', row.lead_id, version);
          if (row.visitor_key) {
            this.db.revokeConsent('visitor', row.visitor_key, version);
          }
        }
        await this.markConsentLedger(row.id, 'delivered', null);
      } catch (error) {
        await this.markConsentLedger(
          row.id,
          'failed',
          error instanceof Error ? error.message.slice(0, 200) : 'consent_drain_failed',
        );
      }
    }
  }

  private async markConsentLedger(
    id: string,
    status: 'delivered' | 'failed',
    lastError: string | null,
  ) {
    const res = await this.supabaseFetch(
      `/rest/v1/meta_ads_consent_ledger?id=eq.${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          nest_status: status,
          last_error: lastError,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`mark_consent_ledger http=${res.status}`);
    }
  }

  private async recoverMissingLeadOutbox() {
    try {
      const res = await this.supabaseFetch(
        '/rest/v1/rpc/lv_recover_missing_meta_lead_outbox',
        {
          method: 'POST',
          body: JSON.stringify({ p_limit: 50 }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`recover_missing_meta_lead_outbox http=${res.status}`);
      }
    } catch (error) {
      this.logger.warn(
        `recover_missing_meta_lead_outbox ${error instanceof Error ? error.message : 'error'}`,
      );
    }
  }

  private async fetchPending(
    limit: number,
    lane: 'test' | 'live',
  ): Promise<SupabaseOutboxRow[]> {
    const qs = new URLSearchParams({
      select: '*',
      status: 'eq.pending',
      delivery_lane: `eq.${lane}`,
      order: 'created_at.asc',
      limit: String(limit),
    });
    const res = await this.supabaseFetch(`/rest/v1/meta_capi_outbox?${qs}`);
    if (!res.ok) {
      throw new Error(`fetch_pending_http_${res.status}`);
    }
    return (await res.json()) as SupabaseOutboxRow[];
  }

  private async leadConsentFalse(leadId: string): Promise<boolean> {
    const qs = new URLSearchParams({
      select: 'meta_ads_consent',
      id: `eq.${leadId}`,
      limit: '1',
    });
    const res = await this.supabaseFetch(`/rest/v1/leads?${qs}`);
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ meta_ads_consent: boolean | null }>;
    return rows[0]?.meta_ads_consent === false;
  }

  /** Versión persistida en ledger Supabase; nunca inventa Date.now(). */
  private async fetchLatestLedgerVersion(opts: {
    leadId?: string | null;
    visitorKey?: string | null;
    adsConsent?: boolean;
  }): Promise<number | null> {
    const params = new URLSearchParams({
      select: 'consent_version',
      order: 'consent_version.desc',
      limit: '1',
    });
    if (opts.leadId) params.set('lead_id', `eq.${opts.leadId}`);
    else if (opts.visitorKey) params.set('visitor_key', `eq.${opts.visitorKey}`);
    else return null;
    if (typeof opts.adsConsent === 'boolean') {
      params.set('ads_consent', `eq.${opts.adsConsent}`);
    }
    const res = await this.supabaseFetch(
      `/rest/v1/meta_ads_consent_ledger?${params}`,
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ consent_version: number }>;
    const v = rows[0]?.consent_version;
    return typeof v === 'number' && v >= 1 ? v : null;
  }

  private async forwardRow(
    row: SupabaseOutboxRow,
  ): Promise<'forwarded' | 'cancelled' | 'failed' | 'skipped'> {
    if (row.status !== 'pending') {
      return 'skipped';
    }

    if (
      this.db.isConsentRevoked({
        visitorKey: row.visitor_key,
        leadId: row.lead_id,
      })
    ) {
      await this.markSupabase(row.id, 'cancelled', 'ads_consent_revoked');
      return 'cancelled';
    }

    if (row.ads_consent_required && row.lead_id) {
      if (await this.leadConsentFalse(row.lead_id)) {
        await this.markSupabase(row.id, 'cancelled', 'ads_consent_revoked');
        const version = await this.fetchLatestLedgerVersion({
          leadId: row.lead_id,
          adsConsent: false,
        });
        if (version != null) {
          this.db.revokeConsent('lead', row.lead_id, version);
        } else {
          this.db.cancelPendingForScope('lead', row.lead_id);
        }
        return 'cancelled';
      }
    }

    const payload = row.payload || {};
    const result = this.events.enqueue({
      event_name: row.event_name,
      idempotency_key: row.idempotency_key,
      event_id: row.event_id,
      event_time: row.event_time,
      action_source:
        (payload.action_source as
          | 'website'
          | 'system_generated'
          | 'business_messaging'
          | 'other'
          | 'chat') || 'website',
      event_source_url:
        typeof payload.event_source_url === 'string'
          ? payload.event_source_url
          : undefined,
      phone: typeof payload.phone === 'string' ? payload.phone : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      full_name:
        typeof payload.full_name === 'string' ? payload.full_name : undefined,
      city: typeof payload.city === 'string' ? payload.city : undefined,
      country: typeof payload.country === 'string' ? payload.country : undefined,
      external_id:
        typeof payload.external_id === 'string'
          ? payload.external_id
          : row.lead_id || undefined,
      visitor_key: row.visitor_key || undefined,
      lead_id: row.lead_id || undefined,
      fbp: typeof payload.fbp === 'string' ? payload.fbp : undefined,
      fbc: typeof payload.fbc === 'string' ? payload.fbc : undefined,
      fbclid: typeof payload.fbclid === 'string' ? payload.fbclid : undefined,
      client_ip_address:
        typeof payload.client_ip_address === 'string'
          ? payload.client_ip_address
          : undefined,
      client_user_agent:
        typeof payload.client_user_agent === 'string'
          ? payload.client_user_agent
          : undefined,
      content_ids: Array.isArray(payload.content_ids)
        ? payload.content_ids.filter((v): v is string => typeof v === 'string')
        : undefined,
      content_name:
        typeof payload.content_name === 'string'
          ? payload.content_name
          : undefined,
      content_category:
        typeof payload.content_category === 'string'
          ? payload.content_category
          : undefined,
      delivery_lane: row.delivery_lane,
      ads_consent: true,
    });

    if (result.blocked_by_consent || result.outbox_status === 'cancelled') {
      await this.markSupabase(row.id, 'cancelled', 'ads_consent_revoked');
      return 'cancelled';
    }

    if (result.ok) {
      await this.markSupabase(row.id, 'forwarded', null);
      return 'forwarded';
    }

    await this.markSupabase(row.id, 'pending', 'drain_enqueue_failed');
    return 'failed';
  }

  private async markSupabase(
    id: string,
    status: 'forwarded' | 'cancelled' | 'pending',
    lastError: string | null,
  ) {
    const body: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
      last_error: lastError,
    };
    if (status === 'forwarded') {
      body.forwarded_at = new Date().toISOString();
    }
    const res = await this.supabaseFetch(
      `/rest/v1/meta_capi_outbox?id=eq.${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`mark_supabase_http_${res.status}`);
    }
  }
}

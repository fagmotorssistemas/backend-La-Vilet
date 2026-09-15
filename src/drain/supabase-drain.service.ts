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
    if (this.config.get<string>('SUPABASE_DRAIN_ENABLED') === 'false') {
      this.logger.log('Supabase drain deshabilitado (SUPABASE_DRAIN_ENABLED=false)');
      return;
    }
    if (!this.isConfigured()) {
      this.logger.warn(
        'Supabase drain inactivo: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
      );
      return;
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
      const batch = Number(this.config.get('SUPABASE_DRAIN_BATCH_SIZE')) || 20;
      const lane = this.meta.mode === 'test' ? 'test' : 'live';
      const rows = await this.fetchPending(batch, lane);
      let forwarded = 0;
      let cancelled = 0;
      let failed = 0;

      for (const row of rows) {
        const outcome = await this.forwardRow(row);
        if (outcome === 'forwarded') forwarded += 1;
        else if (outcome === 'cancelled') cancelled += 1;
        else failed += 1;
      }

      this.lastTickAt = new Date().toISOString();
      this.lastTickError = null;
      if (forwarded || cancelled || failed) {
        this.logger.log(
          `drain forwarded=${forwarded} cancelled=${cancelled} failed=${failed}`,
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

  private async forwardRow(
    row: SupabaseOutboxRow,
  ): Promise<'forwarded' | 'cancelled' | 'failed'> {
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
        this.db.revokeConsent('lead', row.lead_id);
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

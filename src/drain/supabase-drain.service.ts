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
import { decideWaLeadSubmittedConsentGate } from '../meta/wa-lead-submitted-consent-gate';

type SupabaseOutboxRow = {
  id: string;
  idempotency_key: string;
  event_id: string;
  event_name: 'ViewContent' | 'Lead' | 'Schedule' | 'LeadSubmitted';
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
      await this.recoverMissingScheduleOutbox();
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
        // Schedule: delivery efectiva debe estar on (mismo control que FE).
        if (
          row.event_name === 'Schedule' &&
          !this.isScheduleDeliveryEnabled()
        ) {
          skipped += 1;
          this.logger.log(
            `drain skip schedule_delivery_inactive event_id=${row.event_id}`,
          );
          continue;
        }
        // LeadSubmitted BM: mismo flag de entrega WA (default off).
        if (
          row.event_name === 'LeadSubmitted' &&
          !this.isWaLeadSubmittedDeliveryEnabled()
        ) {
          skipped += 1;
          this.logger.log(
            `drain skip wa_lead_submitted_delivery_inactive event_id=${row.event_id}`,
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

  private isScheduleDeliveryEnabled() {
    const raw = String(
      this.config.get<string>('META_SCHEDULE_DELIVERY_ENABLED') || '',
    )
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1';
  }

  private isWaLeadSubmittedDeliveryEnabled() {
    const raw = String(
      this.config.get<string>('META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED') || '',
    )
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1';
  }

  private async recoverMissingScheduleOutbox() {
    const raw = String(
      this.config.get<string>('META_SCHEDULE_RECOVER_ENABLED') || '',
    )
      .trim()
      .toLowerCase();
    if (raw !== 'true' && raw !== '1') return;

    try {
      // Firma única en PG: (p_limit, p_lookback_days DEFAULT 7). Solo p_limit
      // evita ambigüedad PostgREST de sobrecargas homónimas.
      const res = await this.supabaseFetch(
        '/rest/v1/rpc/lv_recover_missing_meta_schedule_outbox',
        {
          method: 'POST',
          body: JSON.stringify({ p_limit: 50 }),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `recover_missing_meta_schedule_outbox http=${res.status}`,
        );
        return;
      }
      // Con delivery ON: promover holds web recuperados (no lote histórico genérico).
      if (this.isScheduleDeliveryEnabled()) {
        await this.promoteRecoveredWebScheduleHolds(50);
      }
    } catch (error) {
      this.logger.warn(
        `recover_missing_meta_schedule_outbox ${error instanceof Error ? error.message : 'error'}`,
      );
    }
  }

  /**
   * Promote acotado de review_hold recuperados → pending (solo si delivery ON).
   *
   * Límites:
   * - Solo `event_name=Schedule`, `status=review_hold`, `last_error` recovered_*.
   * - Solo `action_source=website` (nunca BM/WhatsApp).
   * - Paginación por cursor (created_at, id): omisiones no bloquean filas posteriores.
   * - Cap promote por tick + maxScan para no barrer infinito.
   * - Transición atómica `review_hold` → `pending` (PATCH con filtro status).
   * - Revalida cita: consent, confirmed_by_client, status, canal web, lookback.
   */
  private async promoteRecoveredWebScheduleHolds(limit: number) {
    const lookbackDays = this.scheduleRecoverLookbackDays();
    const pageSize = Math.max(1, Math.min(limit, 50));
    const maxPromote = pageSize;
    const maxScan = Math.max(pageSize * 4, 200);
    let promoted = 0;
    let scanned = 0;
    let cursorId: string | null = null;

    while (scanned < maxScan && promoted < maxPromote) {
      const batch = await this.fetchRecoveredScheduleHoldsPage({
        pageSize,
        cursorId,
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        scanned += 1;
        cursorId = row.id;

        const gate = await this.evaluateRecoveredWebSchedulePromote(
          row,
          lookbackDays,
        );
        if (!gate.ok) {
          if (gate.cancel) {
            const cancelled = await this.transitionSupabaseStatus(
              row.id,
              'review_hold',
              'cancelled',
              gate.reason,
            );
            if (!cancelled) {
              this.logger.log(
                `promote_cancel_race id=${row.id} reason=${gate.reason}`,
              );
            }
          } else {
            this.logger.log(
              `promote_recovered_skip reason=${gate.reason} id=${row.id}`,
            );
          }
          continue;
        }

        const ok = await this.transitionSupabaseStatus(
          row.id,
          'review_hold',
          'pending',
          null,
        );
        if (ok) {
          promoted += 1;
        } else {
          this.logger.log(
            `promote_race_lost id=${row.id} (ya no review_hold)`,
          );
        }
        if (promoted >= maxPromote) break;
      }

      if (batch.length < pageSize) break;
    }

    if (scanned > 0) {
      this.logger.log(
        `promote_recovered scanned=${scanned} promoted=${promoted}`,
      );
    }
  }

  private async fetchRecoveredScheduleHoldsPage(opts: {
    pageSize: number;
    cursorId: string | null;
  }): Promise<
    Array<{
      id: string;
      lead_id: string | null;
      payload: Record<string, unknown> | null;
      last_error: string | null;
      idempotency_key: string;
      created_at: string | null;
    }>
  > {
    const qs = new URLSearchParams({
      select:
        'id,lead_id,payload,last_error,status,event_name,idempotency_key,created_at',
      status: 'eq.review_hold',
      event_name: 'eq.Schedule',
      last_error:
        'in.(recovered_pre_intent_gap,recovered_missing_schedule_outbox)',
      // Cursor por id: omisiones no reaparecen en el mismo barrido.
      order: 'id.asc',
      limit: String(opts.pageSize),
    });
    if (opts.cursorId) {
      qs.set('id', `gt.${opts.cursorId}`);
    }
    const res = await this.supabaseFetch(`/rest/v1/meta_capi_outbox?${qs}`);
    if (!res.ok) {
      this.logger.warn(`promote_recovered_schedule_fetch http=${res.status}`);
      return [];
    }
    return (await res.json()) as Array<{
      id: string;
      lead_id: string | null;
      payload: Record<string, unknown> | null;
      last_error: string | null;
      idempotency_key: string;
      created_at: string | null;
    }>;
  }

  private scheduleRecoverLookbackDays(): number {
    const raw = Number(
      this.config.get<string>('META_SCHEDULE_RECOVER_LOOKBACK_DAYS') || 7,
    );
    if (!Number.isFinite(raw)) return 7;
    return Math.max(1, Math.min(Math.floor(raw), 30));
  }

  /**
   * Revalidación previa al promote (y por tanto previa a cualquier envío).
   * Exportada vía tests del mismo módulo / spec con acceso al método privado.
   */
  private async evaluateRecoveredWebSchedulePromote(
    row: {
      id: string;
      lead_id: string | null;
      payload: Record<string, unknown> | null;
      idempotency_key: string;
    },
    lookbackDays: number,
  ): Promise<{ ok: true } | { ok: false; reason: string; cancel: boolean }> {
    const action = String(row.payload?.action_source || '').toLowerCase();
    if (action !== 'website') {
      return {
        ok: false,
        reason: 'recovered_not_website',
        cancel: false,
      };
    }

    const appointmentId = this.scheduleAppointmentIdFromRow(row);
    if (!appointmentId) {
      return {
        ok: false,
        reason: 'recovered_missing_appointment_id',
        cancel: false,
      };
    }

    const appointment = await this.fetchAppointmentForSchedulePromote(appointmentId);
    if (!appointment) {
      return {
        ok: false,
        reason: 'recovered_appointment_not_found',
        cancel: false,
      };
    }

    if (appointment.confirmed_by_client !== true) {
      return {
        ok: false,
        reason: 'recovered_client_confirmation_missing',
        cancel: true,
      };
    }

    const status = String(appointment.status || '')
      .trim()
      .toLowerCase();
    if (status !== 'aceptado' && status !== 'reprogramado') {
      return {
        ok: false,
        reason: 'recovered_not_confirmed_status',
        cancel: true,
      };
    }

    const channel = String(appointment.channel || '')
      .trim()
      .toLowerCase();
    if (channel !== 'web' && channel !== 'website') {
      return {
        ok: false,
        reason: 'recovered_channel_not_web',
        cancel: true,
      };
    }

    if (!appointment.confirmed_at) {
      return {
        ok: false,
        reason: 'recovered_missing_confirmed_at',
        cancel: true,
      };
    }
    const confirmedMs = Date.parse(appointment.confirmed_at);
    if (!Number.isFinite(confirmedMs)) {
      return {
        ok: false,
        reason: 'recovered_invalid_confirmed_at',
        cancel: true,
      };
    }
    const ageMs = Date.now() - confirmedMs;
    const maxAgeMs = lookbackDays * 24 * 60 * 60 * 1000;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      return {
        ok: false,
        reason: 'recovered_outside_lookback',
        cancel: false,
      };
    }

    const leadId = appointment.lead_id || row.lead_id;
    if (!leadId) {
      return {
        ok: false,
        reason: 'recovered_missing_lead',
        cancel: true,
      };
    }
    if (await this.leadConsentFalse(leadId)) {
      return {
        ok: false,
        reason: 'ads_consent_revoked',
        cancel: true,
      };
    }
    // Consent debe ser explícitamente true (no solo “no false”).
    if (!(await this.leadConsentTrue(leadId))) {
      return {
        ok: false,
        reason: 'ads_consent_missing',
        cancel: true,
      };
    }

    return { ok: true };
  }

  private scheduleAppointmentIdFromRow(row: {
    payload: Record<string, unknown> | null;
    idempotency_key: string;
  }): string | null {
    const fromPayload = String(row.payload?.appointment_id || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(fromPayload)) return fromPayload;
    const key = String(row.idempotency_key || '');
    const m = /^schedule:([0-9a-f-]{36})$/i.exec(key);
    return m ? m[1] : null;
  }

  private async fetchAppointmentForSchedulePromote(appointmentId: string): Promise<{
    id: string;
    lead_id: string | null;
    status: string | null;
    channel: string | null;
    confirmed_by_client: boolean | null;
    confirmed_at: string | null;
  } | null> {
    const qs = new URLSearchParams({
      select:
        'id,lead_id,status,channel,confirmed_by_client,confirmed_at',
      id: `eq.${appointmentId}`,
      limit: '1',
    });
    const res = await this.supabaseFetch(`/rest/v1/appointments?${qs}`);
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      id: string;
      lead_id: string | null;
      status: string | null;
      channel: string | null;
      confirmed_by_client: boolean | null;
      confirmed_at: string | null;
    }>;
    return rows[0] || null;
  }

  private async leadConsentTrue(leadId: string): Promise<boolean> {
    const qs = new URLSearchParams({
      select: 'meta_ads_consent',
      id: `eq.${leadId}`,
      limit: '1',
    });
    const res = await this.supabaseFetch(`/rest/v1/leads?${qs}`);
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ meta_ads_consent: boolean | null }>;
    return rows[0]?.meta_ads_consent === true;
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

  /** Solo LeadSubmitted: true estricto + scope; error → hold. */
  private async leadSubmittedConsentGate(
    row: SupabaseOutboxRow,
    payload: Record<string, unknown>,
  ) {
    const eventTenantId =
      typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
    const eventProjectId =
      typeof payload.project_id === 'string' ? payload.project_id : null;
    const eventContactId =
      typeof payload.contact_id === 'string' ? payload.contact_id : null;

    if (!row.lead_id) {
      return decideWaLeadSubmittedConsentGate({
        queryOk: true,
        leadFound: false,
        metaAdsConsent: null,
        eventTenantId,
        eventProjectId,
        eventContactId,
      });
    }

    try {
      const qs = new URLSearchParams({
        select: 'meta_ads_consent,tenant_id,project_id',
        id: `eq.${row.lead_id}`,
        limit: '1',
      });
      const res = await this.supabaseFetch(`/rest/v1/leads?${qs}`);
      if (!res.ok) {
        return decideWaLeadSubmittedConsentGate({
          queryOk: false,
          leadFound: false,
          metaAdsConsent: null,
          eventTenantId,
          eventProjectId,
          eventContactId,
        });
      }
      const rows = (await res.json()) as Array<{
        meta_ads_consent: boolean | null;
        tenant_id: string | null;
        project_id: string | null;
      }>;
      if (!rows.length) {
        return decideWaLeadSubmittedConsentGate({
          queryOk: true,
          leadFound: false,
          metaAdsConsent: null,
          eventTenantId,
          eventProjectId,
          eventContactId,
        });
      }
      const lead = rows[0];
      return decideWaLeadSubmittedConsentGate({
        queryOk: true,
        leadFound: true,
        metaAdsConsent: lead.meta_ads_consent,
        leadTenantId: lead.tenant_id,
        leadProjectId: lead.project_id,
        eventTenantId,
        eventProjectId,
        eventContactId,
      });
    } catch {
      return decideWaLeadSubmittedConsentGate({
        queryOk: false,
        leadFound: false,
        metaAdsConsent: null,
        eventTenantId,
        eventProjectId,
        eventContactId,
      });
    }
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

    // LeadSubmitted: exige consent exactamente true + scope; error → skip (pending).
    if (row.event_name === 'LeadSubmitted') {
      const gate = await this.leadSubmittedConsentGate(row, payload);
      if (gate.action === 'cancel_revoked') {
        await this.markSupabase(row.id, 'cancelled', gate.reason);
        return 'cancelled';
      }
      if (gate.action === 'hold_pending') {
        this.logger.log(
          `drain hold ${gate.reason} event_id=${row.event_id} (conservado pending)`,
        );
        return 'skipped';
      }
    }

    const actionSource =
      (payload.action_source as
        | 'website'
        | 'system_generated'
        | 'business_messaging'
        | 'other'
        | 'chat') || 'website';

    if (actionSource === 'business_messaging') {
      if (row.event_name === 'Schedule') {
        this.logger.warn(
          `drain cancel bm_schedule_not_supported_by_meta event_id=${row.event_id}`,
        );
        await this.markSupabase(
          row.id,
          'cancelled',
          'business_messaging_schedule_not_supported_by_meta',
        );
        return 'cancelled';
      }
      const ctwa =
        typeof payload.ctwa_clid === 'string' ? payload.ctwa_clid.trim() : '';
      const waba =
        typeof payload.whatsapp_business_account_id === 'string'
          ? payload.whatsapp_business_account_id.trim()
          : '';
      const dataset =
        typeof payload.messaging_dataset_id === 'string'
          ? payload.messaging_dataset_id.trim()
          : '';
      if (!ctwa || !waba || !dataset) {
        this.logger.warn(
          `drain skip bm_identifiers_missing event_id=${row.event_id}`,
        );
        // No encolar con dataset web.
        return 'failed';
      }
    }

    const result = this.events.enqueue({
      event_name: row.event_name,
      idempotency_key: row.idempotency_key,
      event_id: row.event_id,
      event_time: row.event_time,
      action_source: actionSource,
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
      messaging_channel:
        payload.messaging_channel === 'whatsapp' ? 'whatsapp' : undefined,
      ctwa_clid:
        typeof payload.ctwa_clid === 'string' ? payload.ctwa_clid : undefined,
      whatsapp_business_account_id:
        typeof payload.whatsapp_business_account_id === 'string'
          ? payload.whatsapp_business_account_id
          : undefined,
      messaging_dataset_id:
        typeof payload.messaging_dataset_id === 'string'
          ? payload.messaging_dataset_id
          : undefined,
      tenant_id:
        typeof payload.tenant_id === 'string' ? payload.tenant_id : undefined,
      project_id:
        typeof payload.project_id === 'string' ? payload.project_id : undefined,
      contact_id:
        typeof payload.contact_id === 'string' ? payload.contact_id : undefined,
    });

    if (result.blocked_by_consent || result.outbox_status === 'cancelled') {
      await this.markSupabase(row.id, 'cancelled', 'ads_consent_revoked');
      return 'cancelled';
    }

    if (result.ok) {
      await this.markSupabase(row.id, 'forwarded', null);
      if (row.event_name === 'LeadSubmitted') {
        await this.logConversionBestEffort({
          stage: 'backend_accepted',
          eventName: row.event_name,
          reason: 'forwarded_to_nest',
          leadId: row.lead_id,
          eventId: row.event_id,
          idempotencyKey: row.idempotency_key,
          deliveryLane: row.delivery_lane,
          details: { nest_event_id: result.event_id },
        });
      }
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
    const ok = await this.transitionSupabaseStatus(id, null, status, lastError);
    if (!ok) {
      throw new Error(`mark_supabase_no_row id=${id} status=${status}`);
    }
  }

  private async logConversionBestEffort(input: {
    stage: string;
    eventName: string;
    reason: string | null;
    leadId: string | null;
    eventId: string;
    idempotencyKey: string;
    deliveryLane: string;
    details: Record<string, unknown>;
  }) {
    try {
      await this.supabaseFetch('/rest/v1/rpc/lv_log_meta_conversion', {
        method: 'POST',
        body: JSON.stringify({
          p_stage: input.stage,
          p_event_name: input.eventName,
          p_reason: input.reason,
          p_lead_id: input.leadId,
          p_event_id: input.eventId,
          p_idempotency_key: input.idempotencyKey,
          p_delivery_lane: input.deliveryLane,
          p_details: input.details,
        }),
      });
    } catch {
      // soft-fail
    }
  }

  /**
   * Transición condicionada. Si `fromStatus` se indica, solo actualiza filas en ese estado
   * (p. ej. review_hold→pending). Devuelve true solo si hubo fila representada.
   */
  private async transitionSupabaseStatus(
    id: string,
    fromStatus: string | null,
    toStatus: 'forwarded' | 'cancelled' | 'pending',
    lastError: string | null,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      status: toStatus,
      updated_at: new Date().toISOString(),
      last_error: lastError,
    };
    if (toStatus === 'forwarded') {
      body.forwarded_at = new Date().toISOString();
    }
    const filter = fromStatus
      ? `id=eq.${id}&status=eq.${fromStatus}`
      : `id=eq.${id}`;
    const res = await this.supabaseFetch(`/rest/v1/meta_capi_outbox?${filter}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`mark_supabase_http_${res.status}`);
    }
    const rows = (await res.json().catch(() => [])) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  }
}

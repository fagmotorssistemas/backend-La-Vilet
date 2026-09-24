import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import {
  countGraphPayloadEvents,
  evaluateMetaAcceptanceEvidence,
} from '../meta/meta-acceptance';
import {
  decidePurchaseAnnulment,
  saleIdFromPurchaseRow,
} from '../meta/purchase-annulment-gate';
import { evaluatePurchaseActivationGate } from '../meta/purchase-activation-cutover';
import { decideWaLeadSubmittedConsentGate } from '../meta/wa-lead-submitted-consent-gate';

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = false;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly meta: MetaCapiService,
    private readonly config: ConfigService,
  ) {}

  get workerStatus() {
    return {
      enabled: this.enabled,
      ticking: this.running,
      last_tick_at: this.lastTickAt,
      last_tick_error: this.lastTickError,
      poll_ms: Number(this.config.get('OUTBOX_POLL_MS')) || 5000,
    };
  }

  onModuleInit() {
    if (this.config.get<string>('OUTBOX_ENABLED') === 'false') {
      this.logger.log('Outbox worker deshabilitado (OUTBOX_ENABLED=false)');
      this.enabled = false;
      return;
    }
    this.enabled = true;
    const poll = Number(this.config.get('OUTBOX_POLL_MS')) || 5000;
    this.timer = setInterval(() => {
      void this.tick();
    }, poll);
    this.firstTick = setTimeout(() => void this.tick(), 1500);
    this.logger.log(`Outbox worker activo (poll=${poll}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTick) clearTimeout(this.firstTick);
    this.timer = null;
    this.firstTick = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // La sincronización de resultados es independiente del envío Graph. Debe
      // recuperarse incluso si META_MODE se desactiva después de una aceptación.
      await this.flushMetaResultSync();
      const allowed = this.meta.assertModeAllowed();
      if (!allowed.ok) {
        this.lastTickAt = new Date().toISOString();
        this.lastTickError = null;
        return;
      }

      const batch = Number(this.config.get('OUTBOX_BATCH_SIZE')) || 20;
      const maxAttempts = Number(this.config.get('OUTBOX_MAX_ATTEMPTS')) || 8;
      const lane = this.meta.mode === 'test' ? 'test' : 'live';
      const scheduleDeliveryOn = this.isScheduleDeliveryEnabled();
      const waLeadSubmittedDeliveryOn = this.isWaLeadSubmittedDeliveryEnabled();
      const waCrmQualificationDeliveryOn =
        this.isWaCrmQualificationDeliveryEnabled();
      const purchaseDeliveryOn = this.isPurchaseDeliveryEnabled();
      // Delivery OFF: no claim Schedule / LeadSubmitted / Purchase → no se envían ni se pierden.
      const claimed = this.db.claimPending(batch, lane, {
        excludeSchedule: !scheduleDeliveryOn,
        excludeLeadSubmitted: !waLeadSubmittedDeliveryOn,
        excludeQualifiedLead: !waCrmQualificationDeliveryOn,
        excludePurchase: !purchaseDeliveryOn,
      });

      for (const row of claimed) {
        const fresh = this.db.getOutboxById(row.id);
        if (!fresh || fresh.status !== 'processing') {
          continue;
        }
        if (
          fresh.ads_consent_required &&
          this.db.isConsentRevoked({
            visitorKey: fresh.visitor_key,
            leadId: fresh.lead_id,
          })
        ) {
          this.db.cancelProcessingIfRevoked(row.id);
          continue;
        }

        // LeadSubmitted: solo false cancela; null/ausente permiten (fuente leads) + scope.
        // Otros eventos: solo cancelan si consent === false (comportamiento previo).
        if (['LeadSubmitted', 'QualifiedLead'].includes(fresh.event_name)) {
          const gate = await this.resolveLeadSubmittedConsentGate(fresh);
          if (gate.action === 'cancel_revoked') {
            this.db.cancelProcessingIfRevoked(row.id);
            this.logger.log(
              `outbox cancel ${gate.reason} id=${row.id} event=LeadSubmitted`,
            );
            continue;
          }
          if (gate.action === 'hold_pending') {
            this.db.releaseProcessingToPending(row.id, gate.reason);
            this.logger.log(
              `outbox hold ${gate.reason} id=${row.id} (conservado pending)`,
            );
            continue;
          }
        } else if (fresh.ads_consent_required && fresh.lead_id) {
          const leadConsentFalse = await this.supabaseLeadAdsConsentFalse(
            fresh.lead_id,
          );
          if (leadConsentFalse === true) {
            this.db.cancelProcessingIfRevoked(row.id);
            this.logger.log(
              `outbox cancel ads_consent_revoked_pre_graph id=${row.id}`,
            );
            continue;
          }
        }

        if (fresh.event_name === 'Schedule' && !scheduleDeliveryOn) {
          this.db.releaseProcessingToPending(
            row.id,
            'schedule_delivery_inactive',
          );
          this.logger.log(
            `outbox skip schedule_delivery_inactive id=${row.id} (conservado pending)`,
          );
          continue;
        }

        if (
          fresh.event_name === 'LeadSubmitted' &&
          !waLeadSubmittedDeliveryOn
        ) {
          this.db.releaseProcessingToPending(
            row.id,
            'wa_lead_submitted_delivery_inactive',
          );
          this.logger.log(
            `outbox skip wa_lead_submitted_delivery_inactive id=${row.id} (conservado pending)`,
          );
          continue;
        }

        if (
          fresh.event_name === 'QualifiedLead' &&
          !waCrmQualificationDeliveryOn
        ) {
          this.db.releaseProcessingToPending(
            row.id,
            'wa_crm_qualification_delivery_inactive',
          );
          continue;
        }

        if (fresh.event_name === 'Purchase' && !purchaseDeliveryOn) {
          this.db.releaseProcessingToPending(
            row.id,
            'purchase_delivery_inactive',
          );
          this.logger.log(
            `outbox skip purchase_delivery_inactive id=${row.id} (conservado pending)`,
          );
          continue;
        }

        if (fresh.event_name === 'Purchase' && purchaseDeliveryOn) {
          const cutoverGate = this.purchaseActivationGate(fresh);
          if (!cutoverGate.ok) {
            this.db.releaseProcessingToPending(row.id, cutoverGate.reason);
            this.logger.log(`outbox hold ${cutoverGate.reason} id=${row.id}`);
            continue;
          }
          const gate = await this.resolvePurchaseAnnulmentGate(fresh);
          if (gate.action === 'cancel') {
            this.db.cancelByEventIds([fresh.event_id], gate.reason);
            this.logger.log(
              `outbox cancel purchase ${gate.reason} id=${row.id}`,
            );
            continue;
          }
          if (gate.action === 'hold_retry') {
            this.db.releaseProcessingToPending(row.id, gate.reason);
            this.logger.log(`outbox hold purchase ${gate.reason} id=${row.id}`);
            continue;
          }
          if (gate.action === 'annotate_after_accept') {
            const saleId = saleIdFromPurchaseRow(fresh);
            if (saleId) {
              this.db.annotatePurchaseAnnulledAfterAccept(saleId, gate.reason);
            }
            this.db.releaseProcessingToPending(row.id, gate.reason);
            continue;
          }
        }

        let payload = JSON.parse(fresh.graph_payload) as Record<
          string,
          unknown
        >;
        payload = this.meta.applyCoreSetupBeforeGraphSend(payload);
        if (this.meta.mode === 'test' && this.meta.testEventCode) {
          payload.test_event_code = this.meta.testEventCode;
        } else {
          delete payload.test_event_code;
        }

        const credentialGate = this.meta.assertSendAllowedFor(
          payload,
          fresh.event_name,
        );
        if (!credentialGate.ok) {
          this.db.releaseProcessingToPending(row.id, credentialGate.reason);
          this.logger.log(
            `outbox hold credential id=${row.id} event=${fresh.event_name}`,
          );
          continue;
        }

        const expectedEvents = countGraphPayloadEvents(payload);
        const result = await this.meta.sendToMeta(fresh.dataset_id, payload, {
          eventName: fresh.event_name,
        });

        const evidence = evaluateMetaAcceptanceEvidence({
          httpOk: result.httpStatus >= 200 && result.httpStatus < 300,
          httpStatus: result.httpStatus,
          error: result.ok ? undefined : result.errorMessage || 'meta_error',
          eventsReceived: result.eventsReceived,
          expectedEvents,
          eventId: fresh.event_id,
          fbtraceId: result.fbtraceId,
        });

        if (result.ok && evidence.tier === 'api_accepted') {
          const syncPayload = this.metaResultSyncPayload({
            stage: 'meta_accepted',
            eventName: fresh.event_name,
            eventId: fresh.event_id,
            leadId: fresh.lead_id,
            idempotencyKey: fresh.idempotency_key,
            deliveryLane: fresh.delivery_lane,
            datasetId: fresh.dataset_id,
            fbtraceId: result.fbtraceId,
            eventsReceived: result.eventsReceived,
            httpStatus: result.httpStatus,
            expectedEvents,
            correlated: evidence.correlated,
          });
          if (typeof this.db.markSentAndQueueResult === 'function') {
            this.db.markSentAndQueueResult(
              row.id,
              result.bodyRedacted,
              syncPayload,
            );
          } else {
            // Compatibilidad de dobles de prueba antiguos; DatabaseService real
            // siempre expone la operación atómica.
            this.db.markSent(row.id, result.bodyRedacted);
          }
          continue;
        }

        const attempts = fresh.attempt_count;
        const dead = !result.retryable || attempts >= maxAttempts;
        const backoffSec = Math.min(
          3600,
          Math.pow(2, Math.min(attempts, 8)) * 5,
        );
        const next = new Date(Date.now() + backoffSec * 1000).toISOString();
        const deliveryOutcome = result.ok
          ? 'meta_unverified'
          : result.httpStatus === 0
            ? 'transport_failed'
            : 'meta_rejected';
        const syncPayload = this.metaResultSyncPayload({
          stage: deliveryOutcome,
          eventName: fresh.event_name,
          eventId: fresh.event_id,
          leadId: fresh.lead_id,
          idempotencyKey: fresh.idempotency_key,
          deliveryLane: fresh.delivery_lane,
          datasetId: fresh.dataset_id,
          fbtraceId: result.fbtraceId,
          eventsReceived: result.eventsReceived,
          httpStatus: result.httpStatus,
          expectedEvents,
          correlated: evidence.correlated,
          reason: result.errorMessage || evidence.reason || 'unknown',
        });
        if (typeof this.db.markRetryAndQueueResult === 'function') {
          this.db.markRetryAndQueueResult(
            row.id,
            result.errorMessage || evidence.reason || 'unknown',
            next,
            dead,
            deliveryOutcome,
            result.bodyRedacted,
            syncPayload,
          );
        } else {
          this.db.markRetry(
            row.id,
            result.errorMessage || evidence.reason || 'unknown',
            next,
            dead,
          );
        }
        this.logger.warn(
          `outbox id=${row.id} event=${row.event_name} attempt=${attempts} dead=${dead}`,
        );
      }

      const retention = Number(this.config.get('OUTBOX_RETENTION_DAYS')) || 90;
      this.db.purgeOld(retention);
      await this.flushMetaResultSync();
      this.lastTickAt = new Date().toISOString();
      this.lastTickError = null;
    } catch (error) {
      this.lastTickError =
        error instanceof Error ? error.message.slice(0, 200) : 'tick_failed';
      this.logger.error(
        'outbox tick failed',
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
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

  private isWaCrmQualificationDeliveryEnabled() {
    const raw = String(
      this.config.get<string>('META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED') ||
        '',
    )
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1';
  }

  /** Purchase tipado; envío Graph apagado por defecto hasta activación explícita. */
  private isPurchaseDeliveryEnabled() {
    const raw = String(
      this.config.get<string>('META_PURCHASE_DELIVERY_ENABLED') || '',
    )
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1';
  }

  /**
   * Corte: registered_at (CRM) Y sale_at (confirmación comercial existente).
   * Ambos deben ser >= META_PURCHASE_ACTIVATED_AT. No inventa fechas.
   */
  private purchaseActivationGate(row: {
    created_at: string;
    event_time: number;
    payload_redacted: string | null;
  }): { ok: true } | { ok: false; reason: string } {
    let registeredAt: unknown = null;
    let saleAt: unknown = null;
    try {
      const parsed = JSON.parse(row.payload_redacted || '{}') as Record<
        string,
        unknown
      >;
      const details =
        parsed.details && typeof parsed.details === 'object'
          ? (parsed.details as Record<string, unknown>)
          : null;
      registeredAt =
        (typeof parsed.registered_at === 'string' && parsed.registered_at) ||
        (typeof details?.registered_at === 'string' && details.registered_at) ||
        null;
      saleAt =
        (typeof parsed.sale_at === 'string' && parsed.sale_at) ||
        (typeof details?.sale_at === 'string' && details.sale_at) ||
        null;
    } catch {
      registeredAt = null;
      saleAt = null;
    }
    return evaluatePurchaseActivationGate({
      registeredAt,
      saleAt,
      eventTime: row.event_time,
      activatedAt: this.config.get<string>('META_PURCHASE_ACTIVATED_AT'),
    });
  }

  /**
   * Valida anulación CRM antes de Graph y en reintentos.
   * Sin SUPABASE_* → hold (no enviar a ciegas).
   */
  private async resolvePurchaseAnnulmentGate(row: {
    idempotency_key: string;
    payload_redacted: string | null;
    status: string;
  }) {
    const saleId = saleIdFromPurchaseRow(row);
    if (!saleId) {
      return decidePurchaseAnnulment(null);
    }
    const url = this.supabaseUrl();
    const key = this.serviceRoleKey();
    if (!url || !key) {
      return decidePurchaseAnnulment(null, { lookupFailed: true });
    }
    try {
      const qs = new URLSearchParams({
        select: 'id,contract_id,contract:contracts(id,status)',
        id: `eq.${saleId}`,
        limit: '1',
      });
      const res = await fetch(`${url}/rest/v1/unit_sales_closings?${qs}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return decidePurchaseAnnulment(null, { lookupFailed: true });
      }
      const rows = (await res.json()) as Array<{
        id: string;
        contract_id: string | null;
        contract:
          | { id: string; status: string | null }
          | { id: string; status: string | null }[]
          | null;
      }>;
      if (!rows.length) {
        return decidePurchaseAnnulment(null);
      }
      const c = rows[0].contract;
      const contract = Array.isArray(c) ? c[0] : c;
      return decidePurchaseAnnulment({
        saleId,
        contractId: contract?.id || rows[0].contract_id,
        contractStatus: contract?.status ?? null,
        nestAlreadyAccepted: false,
      });
    } catch {
      return decidePurchaseAnnulment(null, { lookupFailed: true });
    }
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

  /** true = consent false en leads; null = no consultable. Solo Lead/VC/Schedule. */
  private async supabaseLeadAdsConsentFalse(
    leadId: string,
  ): Promise<boolean | null> {
    const url = this.supabaseUrl();
    const key = this.serviceRoleKey();
    if (!url || !key || !leadId) return null;
    try {
      const qs = new URLSearchParams({
        select: 'meta_ads_consent',
        id: `eq.${leadId}`,
        limit: '1',
      });
      const res = await fetch(`${url}/rest/v1/leads?${qs}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{
        meta_ads_consent: boolean | null;
      }>;
      if (!rows.length) return null;
      return rows[0].meta_ads_consent === false;
    } catch {
      return null;
    }
  }

  private async resolveLeadSubmittedConsentGate(row: {
    lead_id: string | null;
    graph_payload: string;
    payload_redacted?: string;
  }) {
    let redacted: Record<string, unknown> = {};
    try {
      redacted = JSON.parse(row.payload_redacted || '{}') as Record<
        string,
        unknown
      >;
    } catch {
      redacted = {};
    }

    const eventTenantId =
      typeof redacted.tenant_id === 'string' ? redacted.tenant_id : null;
    const eventProjectId =
      typeof redacted.project_id === 'string' ? redacted.project_id : null;
    const eventContactId =
      typeof redacted.contact_id === 'string' ? redacted.contact_id : null;

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

    const url = this.supabaseUrl();
    const key = this.serviceRoleKey();
    if (!url || !key) {
      return decideWaLeadSubmittedConsentGate({
        queryOk: false,
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
      const res = await fetch(`${url}/rest/v1/leads?${qs}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
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

  private metaResultSyncPayload(input: {
    stage: string;
    eventName: string;
    eventId: string;
    leadId: string | null;
    idempotencyKey: string;
    deliveryLane: string;
    datasetId: string;
    fbtraceId: string | null;
    eventsReceived: number | null;
    httpStatus: number;
    expectedEvents: number;
    correlated: boolean;
    reason?: string | null;
  }): Record<string, unknown> {
    return {
      p_stage: input.stage,
      p_event_name: input.eventName,
      p_reason: input.reason || null,
      p_lead_id: input.leadId,
      p_event_id: input.eventId,
      p_idempotency_key: input.idempotencyKey,
      p_delivery_lane: input.deliveryLane,
      p_details: {
        fbtrace_id: input.fbtraceId,
        events_received: input.eventsReceived,
        expected_events: input.expectedEvents,
        http_status: input.httpStatus,
        dataset_id: input.datasetId,
        correlated: input.correlated,
        acceptance_layer: 'graph_api',
        events_manager: 'not_verified_here',
      },
    };
  }

  private async flushMetaResultSync() {
    if (typeof this.db.claimMetaResultSync !== 'function') return;
    const url = this.supabaseUrl();
    const key = this.serviceRoleKey();
    if (!url || !key) return;
    const rows = this.db.claimMetaResultSync(20);
    for (const row of rows) {
      try {
        const rpcPayload = JSON.parse(row.payload_json) as Record<
          string,
          unknown
        >;
        const logRow = {
          id: deterministicResultSyncId(row.event_id, row.stage),
          event_name: rpcPayload.p_event_name,
          stage: rpcPayload.p_stage,
          reason: rpcPayload.p_reason,
          lead_id: rpcPayload.p_lead_id,
          event_id: rpcPayload.p_event_id,
          idempotency_key: rpcPayload.p_idempotency_key,
          delivery_lane: rpcPayload.p_delivery_lane,
          details: rpcPayload.p_details,
        };
        const response = await fetch(
          `${url}/rest/v1/meta_capi_conversion_log?on_conflict=id`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${key}`,
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(logRow),
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) {
          throw new Error(`result_sync_http_${response.status}`);
        }
        this.db.markMetaResultSynced(row.id);
      } catch (error) {
        const backoffSec = Math.min(
          3600,
          Math.pow(2, Math.min(row.attempt_count, 8)) * 5,
        );
        this.db.markMetaResultSyncRetry(
          row.id,
          error instanceof Error ? error.message : 'result_sync_failed',
          new Date(Date.now() + backoffSec * 1000).toISOString(),
        );
      }
    }
  }
}

/** UUID estable para que un timeout tras commit pueda reintentarse sin duplicar. */
export function deterministicResultSyncId(
  eventId: string,
  stage: string,
): string {
  const hex = createHash('sha256')
    .update(`lavilet-meta-result:${eventId}:${stage}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

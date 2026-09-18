import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import {
  countGraphPayloadEvents,
  evaluateMetaAcceptanceEvidence,
} from '../meta/meta-acceptance';

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
      const allowed = this.meta.assertSendAllowed();
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
      // Delivery OFF: no claim Schedule / LeadSubmitted → no se envían ni se pierden; Lead/VC siguen.
      const claimed = this.db.claimPending(batch, lane, {
        excludeSchedule: !scheduleDeliveryOn,
        excludeLeadSubmitted: !waLeadSubmittedDeliveryOn,
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

        // Revocación tras encolar: revalidar lead en Supabase antes de Graph.
        if (fresh.ads_consent_required && fresh.lead_id) {
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

        if (fresh.event_name === 'LeadSubmitted' && !waLeadSubmittedDeliveryOn) {
          this.db.releaseProcessingToPending(
            row.id,
            'wa_lead_submitted_delivery_inactive',
          );
          this.logger.log(
            `outbox skip wa_lead_submitted_delivery_inactive id=${row.id} (conservado pending)`,
          );
          continue;
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

        const expectedEvents = countGraphPayloadEvents(payload);
        const result = await this.meta.sendToMeta(fresh.dataset_id, payload);

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
          this.db.markSent(row.id, result.bodyRedacted);
          await this.logMetaAccepted({
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
          continue;
        }

        if (result.ok && evidence.tier !== 'api_accepted') {
          await this.logMetaConversion({
            stage: 'meta_rejected',
            eventName: fresh.event_name,
            reason: evidence.reason || 'insufficient_meta_acceptance_evidence',
            eventId: fresh.event_id,
            leadId: fresh.lead_id,
            idempotencyKey: fresh.idempotency_key,
            deliveryLane: fresh.delivery_lane,
            details: {
              fbtrace_id: result.fbtraceId,
              events_received: result.eventsReceived,
              expected_events: expectedEvents,
              http_status: result.httpStatus,
              dataset_id: fresh.dataset_id,
              acceptance_tier: evidence.tier,
              note: 'api_http_ok_but_not_counted_as_meta_accepted',
            },
          });
        } else if (fresh.event_name === 'LeadSubmitted') {
          await this.logMetaConversion({
            stage: 'meta_rejected',
            eventName: fresh.event_name,
            reason: result.errorMessage || 'meta_error',
            eventId: fresh.event_id,
            leadId: fresh.lead_id,
            idempotencyKey: fresh.idempotency_key,
            deliveryLane: fresh.delivery_lane,
            details: {
              fbtrace_id: result.fbtraceId,
              events_received: result.eventsReceived,
              expected_events: expectedEvents,
              http_status: result.httpStatus,
              dataset_id: fresh.dataset_id,
              acceptance_tier: evidence.tier,
            },
          });
        }

        const attempts = fresh.attempt_count;
        const dead = !result.retryable || attempts >= maxAttempts;
        const backoffSec = Math.min(
          3600,
          Math.pow(2, Math.min(attempts, 8)) * 5,
        );
        const next = new Date(Date.now() + backoffSec * 1000).toISOString();
        this.db.markRetry(
          row.id,
          result.errorMessage || evidence.reason || 'unknown',
          next,
          dead,
        );
        this.logger.warn(
          `outbox id=${row.id} event=${row.event_name} attempt=${attempts} dead=${dead}`,
        );
      }

      const retention = Number(this.config.get('OUTBOX_RETENTION_DAYS')) || 90;
      this.db.purgeOld(retention);
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

  /** true = consent false en leads; null = no consultable. */
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

  private async logMetaAccepted(input: {
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
  }) {
    await this.logMetaConversion({
      stage: 'meta_accepted',
      eventName: input.eventName,
      reason: null,
      eventId: input.eventId,
      leadId: input.leadId,
      idempotencyKey: input.idempotencyKey,
      deliveryLane: input.deliveryLane,
      details: {
        fbtrace_id: input.fbtraceId,
        events_received: input.eventsReceived,
        expected_events: input.expectedEvents,
        http_status: input.httpStatus,
        dataset_id: input.datasetId,
        correlated: input.correlated,
        acceptance_layer: 'graph_api',
        events_manager: 'not_verified_here',
      },
    });
  }

  private async logMetaConversion(input: {
    stage: string;
    eventName: string;
    reason: string | null;
    eventId: string;
    leadId: string | null;
    idempotencyKey: string;
    deliveryLane: string;
    details: Record<string, unknown>;
  }) {
    const url = this.supabaseUrl();
    const key = this.serviceRoleKey();
    if (!url || !key) return;
    try {
      await fetch(`${url}/rest/v1/rpc/lv_log_meta_conversion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
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
}

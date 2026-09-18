import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';

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
      // Delivery OFF: no claim de Schedule / LeadSubmitted → no se envían ni se pierden; Lead/VC siguen.
      const claimed = this.db.claimPending(batch, lane, {
        excludeSchedule: !scheduleDeliveryOn,
        excludeLeadSubmitted: !waLeadSubmittedDeliveryOn,
      });

      for (const row of claimed) {
        // Revalidar estado + consentimiento inmediatamente antes de enviar.
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

        // Defensa: Schedule no sale a Graph si delivery se apagó tras el claim.
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

        // Defensa: LeadSubmitted BM — apagado efectivo también para ya encolados.
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
        // Core Setup: revalidar siempre antes de Graph (incluye cola antigua).
        payload = this.meta.applyCoreSetupBeforeGraphSend(payload);
        if (this.meta.mode === 'test' && this.meta.testEventCode) {
          payload.test_event_code = this.meta.testEventCode;
        } else {
          delete payload.test_event_code;
        }

        const result = await this.meta.sendToMeta(fresh.dataset_id, payload);

        // Tras await: no sobrescribir si se canceló concurrentemente.
        if (result.ok) {
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
          });
          continue;
        }

        if (fresh.event_name === 'LeadSubmitted') {
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
              http_status: result.httpStatus,
              dataset_id: fresh.dataset_id,
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
        this.db.markRetry(row.id, result.errorMessage || 'unknown', next, dead);
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
        http_status: input.httpStatus,
        dataset_id: input.datasetId,
        correlated: Boolean(input.eventId && input.fbtraceId),
      },
    });
  }

  /** Best-effort bitácora Supabase; no bloquea el worker. */
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

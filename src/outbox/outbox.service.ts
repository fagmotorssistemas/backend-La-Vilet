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
      const claimed = this.db.claimPending(batch, lane);

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

        const payload = JSON.parse(fresh.graph_payload) as Record<
          string,
          unknown
        >;
        if (this.meta.mode === 'test' && this.meta.testEventCode) {
          payload.test_event_code = this.meta.testEventCode;
        } else {
          delete payload.test_event_code;
        }

        const result = await this.meta.sendToMeta(fresh.dataset_id, payload);

        // Tras await: no sobrescribir si se canceló concurrentemente.
        if (result.ok) {
          this.db.markSent(row.id, result.bodyRedacted);
          continue;
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
}

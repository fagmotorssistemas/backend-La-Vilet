import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from '../meta/meta-capi.service';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { SupabaseDrainService } from '../drain/supabase-drain.service';
import { WhatsappWebhookService } from '../whatsapp/whatsapp-webhook.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly meta: MetaCapiService,
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly drain: SupabaseDrainService,
    private readonly waWebhook: WhatsappWebhookService,
  ) {}

  @Get()
  getHealth() {
    const gate = this.meta.assertSendAllowed();
    return {
      ok: true,
      service: 'lavilet-meta-capi',
      mode: this.meta.mode,
      dataset_configured: Boolean(this.meta.datasetId),
      api_version: this.meta.apiVersion,
      wa_api_version: this.meta.waApiVersion,
      test_code_present: Boolean(this.meta.testEventCode),
      token_configured: Boolean(this.meta.accessToken),
      wa_messaging_token_configured: Boolean(
        this.meta.waMessagingAccessToken,
      ),
      delivery_enabled: gate.ok,
      delivery_reason: gate.ok ? null : gate.reason,
      core_setup_conservative: this.meta.coreSetupConservative,
      purchase_delivery_enabled:
        String(
          this.config.get<string>('META_PURCHASE_DELIVERY_ENABLED') || '',
        )
          .trim()
          .toLowerCase() === 'true',
      purchase_activated_at:
        String(
          this.config.get<string>('META_PURCHASE_ACTIVATED_AT') || '',
        ).trim() || null,
      persistence: {
        database_path: this.db.databasePath,
      },
      outbox: {
        counts: this.db.countsByStatus(),
        worker: this.outbox.workerStatus,
      },
      supabase_drain: this.drain.status,
      wa_cloud_webhook: this.waWebhook.healthSnapshot(),
    };
  }
}

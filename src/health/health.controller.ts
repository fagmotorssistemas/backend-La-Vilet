import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from '../meta/meta-capi.service';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { SupabaseDrainService } from '../drain/supabase-drain.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly meta: MetaCapiService,
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly drain: SupabaseDrainService,
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
      test_code_present: Boolean(this.meta.testEventCode),
      token_configured: Boolean(this.meta.accessToken),
      delivery_enabled: gate.ok,
      delivery_reason: gate.ok ? null : gate.reason,
      persistence: {
        database_path: this.db.databasePath,
      },
      outbox: {
        counts: this.db.countsByStatus(),
        worker: this.outbox.workerStatus,
      },
      supabase_drain: this.drain.status,
    };
  }
}

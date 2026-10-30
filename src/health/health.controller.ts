import { Controller, Get, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { hasValidInternalSecret } from '../auth/auth.module';
import { parseBoolFlag } from '../common/utils/env-flags';
import { readDeliveryFlags } from '../meta/delivery-flags';
import { MetaCapiService } from '../meta/meta-capi.service';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { SupabaseDrainService } from '../drain/supabase-drain.service';
import { WhatsappWebhookService } from '../whatsapp/whatsapp-webhook.service';

/** Sustituidas por META_QUALIFIED_PURCHASE_* y META_SALE_* (Purchase ≠ venta). */
const DEPRECATED_ENV = [
  'META_PURCHASE_DELIVERY_ENABLED',
  'META_PURCHASE_ACTIVATED_AT',
];

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

  private deliverySwitches() {
    const flags = readDeliveryFlags(this.config);
    return {
      schedule_delivery_enabled: flags.schedule,
      wa_lead_submitted_delivery_enabled: flags.waLeadSubmitted,
      wa_crm_qualification_delivery_enabled: flags.waCrmQualification,
      /** Purchase = contacto calificado (web o WhatsApp). */
      qualified_purchase_delivery_enabled: flags.qualifiedPurchase,
      /** Valor = precio de la unidad que manda el CRM; este es solo el respaldo. */
      qualified_purchase_value_source: 'crm_unit_price',
      qualified_purchase_value_configured:
        this.meta.qualifiedPurchaseValue != null,
      /** VentaCerrada = venta real (solo medición). */
      sale_delivery_enabled: flags.sale,
      sale_activated_at: this.meta.saleActivatedAt,
      funnel_events_delivery_enabled: flags.funnel,
      signal_cascade_enabled: this.meta.signalCascadeEnabled,
      /** Variables antiguas sin efecto: revisar el .env si aparecen. */
      deprecated_env_present: DEPRECATED_ENV.filter((key) =>
        String(this.config.get<string>(key) || '').trim(),
      ),
    };
  }

  /**
   * HEALTH_DETAILS_PUBLIC=false: público solo { ok, service, mode }. El detalle
   * (interruptores, colas, webhook) pide el secreto interno, salvo el
   * HEALTHCHECK dentro del contenedor. Por defecto (true) responde como antes,
   * para no romper los scripts del droplet que leen el detalle sin secreto.
   */
  @Get()
  getHealth(@Req() req: Request) {
    if (!this.canSeeDetails(req)) {
      return { ok: true, service: 'lavilet-meta-capi', mode: this.meta.mode };
    }
    return this.healthDetails();
  }

  private canSeeDetails(req: Request): boolean {
    if (parseBoolFlag(this.config.get<string>('HEALTH_DETAILS_PUBLIC'), true)) {
      return true;
    }
    if (hasValidInternalSecret(req, this.config)) return true;
    return isDirectLoopback(req);
  }

  private healthDetails() {
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
      wa_messaging_token_configured: Boolean(this.meta.waMessagingAccessToken),
      delivery_enabled: gate.ok,
      delivery_reason: gate.ok ? null : gate.reason,
      /** Carril WhatsApp (mensajería): modo válido + token WA propio. */
      wa_delivery_enabled:
        this.meta.assertModeAllowed().ok &&
        Boolean(this.meta.waMessagingAccessToken),
      core_setup_conservative: this.meta.coreSetupConservative,
      // Interruptores de entrega: misma lectura que worker y drain.
      ...this.deliverySwitches(),
      persistence: {
        database_path: this.db.databasePath,
      },
      outbox: {
        counts: this.db.countsByStatus(),
        delivery_by_event_channel_dataset: this.db.deliveryBreakdown(),
        result_sync_counts: this.db.countsMetaResultSync(),
        worker: this.outbox.workerStatus,
      },
      supabase_drain: this.drain.status,
      wa_cloud_webhook: this.waWebhook.healthSnapshot(),
    };
  }
}

/**
 * Petición desde el propio contenedor (HEALTHCHECK de Docker) y sin cabeceras
 * de proxy. Lo que llega por el puerto publicado entra desde la red de Docker.
 */
export function isDirectLoopback(req: Request): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
  const remote = String(req.socket?.remoteAddress || '');
  return (
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  );
}

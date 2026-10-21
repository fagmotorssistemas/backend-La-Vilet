import type { ConfigService } from '@nestjs/config';
import { parseBoolFlag } from '../common/utils/env-flags';

/** Interruptores de entrega a Meta. Todos apagados por defecto salvo web clásico. */
export type DeliveryFlags = {
  schedule: boolean;
  waLeadSubmitted: boolean;
  waCrmQualification: boolean;
  /** Purchase = contacto calificado. */
  qualifiedPurchase: boolean;
  /** VentaCerrada = venta real. */
  sale: boolean;
  /** Search, InitiateCheckout y ViewContent por WhatsApp. */
  funnel: boolean;
};

/**
 * Una sola lectura para worker, drain y health. Mismas claves que los getters
 * de MetaCapiService (que usa la API al responder el estado de entrega).
 */
export function readDeliveryFlags(config: ConfigService): DeliveryFlags {
  const flag = (key: string) => parseBoolFlag(config.get<string>(key));
  return {
    schedule: flag('META_SCHEDULE_DELIVERY_ENABLED'),
    waLeadSubmitted: flag('META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED'),
    waCrmQualification: flag('META_WA_CRM_QUALIFICATION_DELIVERY_ENABLED'),
    qualifiedPurchase: flag('META_QUALIFIED_PURCHASE_DELIVERY_ENABLED'),
    sale: flag('META_SALE_DELIVERY_ENABLED'),
    funnel: flag('META_FUNNEL_EVENTS_DELIVERY_ENABLED'),
  };
}

/** Eventos que dependen de un interruptor (excluibles por nombre). */
export const GATED_EVENT_NAMES = [
  'Schedule',
  'LeadSubmitted',
  'QualifiedLead',
  'Purchase',
  'VentaCerrada',
  'Search',
  'InitiateCheckout',
] as const;

/** Motivo de retención por interruptor apagado (null = puede salir). */
export function deliveryInactiveReason(
  eventName: string,
  actionSource: string | null,
  flags: DeliveryFlags,
): string | null {
  if (eventName === 'Schedule' && !flags.schedule) {
    return 'schedule_delivery_inactive';
  }
  if (eventName === 'LeadSubmitted' && !flags.waLeadSubmitted) {
    return 'wa_lead_submitted_delivery_inactive';
  }
  if (eventName === 'QualifiedLead' && !flags.waCrmQualification) {
    return 'wa_crm_qualification_delivery_inactive';
  }
  if (eventName === 'Purchase' && !flags.qualifiedPurchase) {
    return 'qualified_purchase_delivery_inactive';
  }
  if (eventName === 'VentaCerrada' && !flags.sale) {
    return 'sale_delivery_inactive';
  }
  const funnelEvent =
    eventName === 'Search' ||
    eventName === 'InitiateCheckout' ||
    (eventName === 'ViewContent' && actionSource === 'business_messaging');
  if (funnelEvent && !flags.funnel) {
    return 'funnel_events_delivery_inactive';
  }
  return null;
}

/** Nombres con entrega apagada: no se reclaman ni se piden a Supabase. */
export function inactiveEventNames(flags: DeliveryFlags): string[] {
  return GATED_EVENT_NAMES.filter(
    (name) => deliveryInactiveReason(name, null, flags) !== null,
  );
}

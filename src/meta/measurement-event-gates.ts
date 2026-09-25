/**
 * Validación de eventos de medición website (ViewContent subtypes, Wishlist, Purchase).
 * Sin I/O. No inventa unit_id ni currency.
 */

export type LvInternalSubtype =
  | 'showroom_general'
  | 'detalle_unidad'
  | 'favorito'
  | 'solicitud'
  | 'cita'
  | 'compra'
  | string;

export type MeasurementGateResult =
  { ok: true } | { ok: false; reason: string };

const ISO4217 = /^[A-Z]{3}$/;

export function normalizeCurrency(
  raw: string | null | undefined,
): string | null {
  const c = String(raw || '')
    .trim()
    .toUpperCase();
  if (!c) return null;
  if (!ISO4217.test(c)) return null;
  return c;
}

/**
 * ViewContent:
 * - showroom_general: no exige unit; no inventar content_ids
 * - detalle_unidad: unit_id obligatorio; home_listing se resuelve en resolveHomeListingContent
 */
export function gateViewContent(input: {
  subtype?: string | null;
  unitId?: string | null;
  contentIds?: string[] | null;
}): MeasurementGateResult {
  const subtype = String(input.subtype || '').trim();
  if (subtype === 'showroom_general') {
    // Unidad inventada / content_ids forzados: rechazar si el productor los manda como único id inventado.
    // Permitimos content_ids vacío/ausente. Si envían content_ids, no es error (FE conservative no los manda).
    return { ok: true };
  }
  if (subtype === 'detalle_unidad') {
    const unit = String(input.unitId || '').trim();
    if (!unit) {
      return { ok: false, reason: 'detalle_unidad_requires_unit_id' };
    }
    return { ok: true };
  }
  // Subtipo ausente: compat hacia atrás (VC legacy sin subtype).
  return { ok: true };
}

export function gateAddToWishlist(input: {
  actionSource: string;
  leadId?: string | null;
  unitId?: string | null;
}): MeasurementGateResult {
  if (input.actionSource !== 'website') {
    return { ok: false, reason: 'wishlist_website_only' };
  }
  if (!String(input.leadId || '').trim()) {
    return { ok: false, reason: 'wishlist_lead_id_required' };
  }
  if (!String(input.unitId || '').trim()) {
    return { ok: false, reason: 'wishlist_unit_id_required' };
  }
  return { ok: true };
}

/**
 * Purchase (cierre CRM → CAPI):
 * - action_source=system_generated (Meta: conversión automática/CRM; no website
 *   por registrar en CRM web, ni business_messaging por lead WA).
 * - Meta exige value + currency ISO-4217.
 * - Fuente: unit_sales_closings (sale_id). Sin currency → bloqueo.
 */
export function gatePurchase(input: {
  actionSource: string;
  saleId?: string | null;
  leadId?: string | null;
  unitId?: string | null;
  value?: number | null;
  currency?: string | null;
}): MeasurementGateResult {
  const source = String(input.actionSource || '').trim();
  // Docs server-event action_source: CRM/offline no es "website".
  // Docs CAPI for CRM platforms: system_generated.
  // business_messaging = CTWA Messenger/IG/WA ads — no por procedencia del lead.
  if (source !== 'system_generated') {
    return { ok: false, reason: 'purchase_system_generated_crm_only' };
  }
  if (!String(input.saleId || '').trim()) {
    return { ok: false, reason: 'purchase_sale_id_required' };
  }
  if (!String(input.leadId || '').trim()) {
    return { ok: false, reason: 'purchase_lead_id_required' };
  }
  if (!String(input.unitId || '').trim()) {
    return { ok: false, reason: 'purchase_unit_id_required' };
  }
  if (
    input.value == null ||
    !Number.isFinite(Number(input.value)) ||
    Number(input.value) <= 0
  ) {
    return { ok: false, reason: 'purchase_value_required' };
  }
  const currency = normalizeCurrency(input.currency);
  if (!currency) {
    return { ok: false, reason: 'purchase_currency_required_iso4217' };
  }
  return { ok: true };
}

/** content_ids para showroom_general: nunca inventar desde unit_id. */
export function resolveViewContentContentIds(input: {
  subtype?: string | null;
  unitId?: string | null;
  contentIds?: string[] | null;
}): string[] | undefined {
  return resolveHomeListingContent(input).contentIds;
}

/**
 * Identidad catálogo inmobiliario para Graph:
 * - showroom_general: nunca inventar desde unit_id (solo lo del productor).
 * - con unit_id: content_type=home_listing y content_ids=[unit_id]
 *   (si el productor ya mandó ids, se conservan para que el gate valide coherencia).
 * - sin unit_id: no inventa.
 */
export function resolveHomeListingContent(input: {
  subtype?: string | null;
  unitId?: string | null;
  contentIds?: string[] | null;
  contentType?: string | null;
}): {
  contentType?: 'home_listing';
  contentIds?: string[];
} {
  const subtype = String(input.subtype || '').trim();
  const unitId = String(input.unitId || '').trim() || null;
  const producerIds = input.contentIds?.length
    ? [...input.contentIds]
    : undefined;
  const producerType =
    input.contentType === 'home_listing' ? ('home_listing' as const) : undefined;

  if (subtype === 'showroom_general') {
    return { contentType: producerType, contentIds: producerIds };
  }

  if (!unitId) {
    return { contentType: producerType, contentIds: producerIds };
  }

  return {
    contentType: 'home_listing',
    contentIds: producerIds ?? [unitId],
  };
}

/** Catálogo inmobiliario: exige unit_id y content_ids=[unit_id] si hay home_listing. */
export function gateHomeListingContent(input: {
  contentType?: string | null;
  contentIds?: string[] | null;
  unitId?: string | null;
}): MeasurementGateResult {
  if (input.contentType !== 'home_listing') return { ok: true };
  const unitId = String(input.unitId || '').trim();
  if (!unitId) return { ok: false, reason: 'home_listing_unit_id_required' };
  if (
    !Array.isArray(input.contentIds) ||
    input.contentIds.length !== 1 ||
    input.contentIds[0] !== unitId
  ) {
    return {
      ok: false,
      reason: 'home_listing_content_ids_must_match_unit_id',
    };
  }
  return { ok: true };
}

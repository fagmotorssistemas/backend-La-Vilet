/**
 * Validación de eventos de medición (ViewContent, Search, InitiateCheckout,
 * Wishlist, Purchase = contacto calificado, VentaCerrada = venta real).
 * Sin I/O. No inventa unit_id, valor ni currency.
 */

export type LvInternalSubtype =
  | 'showroom_general'
  | 'detalle_unidad'
  | 'favorito'
  | 'solicitud'
  | 'cita'
  | 'compra'
  // Admite subtipos futuros sin perder el autocompletado de los conocidos.
  | (string & Record<never, never>);

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

/** Máximo de unidades por Search (Meta: ids de los primeros resultados). */
export const SEARCH_MAX_CONTENT_IDS = 10;

/**
 * Purchase = contacto calificado (no la venta). Lo dispara una señal real de
 * intención de compra: el bot/CRM lo marca tibio o caliente, pide visita,
 * reserva o financiamiento. Es el único evento CAPI con el que Meta optimiza
 * anuncios Click-to-WhatsApp, por eso necesita volumen.
 * - Canal: website (360/formulario) o business_messaging (WhatsApp).
 * - lead_id obligatorio: siempre es una persona ya identificada.
 * - El valor es fijo y viene de configuración (META_QUALIFIED_PURCHASE_VALUE).
 * La venta real es VentaCerrada.
 */
export function gateQualifiedPurchase(input: {
  actionSource: string;
  leadId?: string | null;
}): MeasurementGateResult {
  const source = String(input.actionSource || '').trim();
  if (source === 'system_generated') {
    return {
      ok: false,
      reason: 'purchase_is_qualified_contact_use_venta_cerrada',
    };
  }
  if (source !== 'website' && source !== 'business_messaging') {
    return { ok: false, reason: 'purchase_website_or_whatsapp_only' };
  }
  if (!String(input.leadId || '').trim()) {
    return { ok: false, reason: 'purchase_lead_id_required' };
  }
  return { ok: true };
}

/**
 * VentaCerrada (evento propio: cierre CRM real → CAPI). Solo para medir el
 * retorno real; nunca llega a 50 por semana, no se usa para optimizar.
 * - action_source=system_generated (CRM; no website ni business_messaging).
 * - value + currency ISO-4217 reales del cierre. Fuente: unit_sales_closings.
 */
export function gateSale(input: {
  actionSource: string;
  saleId?: string | null;
  leadId?: string | null;
  unitId?: string | null;
  value?: number | null;
  currency?: string | null;
}): MeasurementGateResult {
  const source = String(input.actionSource || '').trim();
  if (source !== 'system_generated') {
    return { ok: false, reason: 'sale_system_generated_crm_only' };
  }
  if (!String(input.saleId || '').trim()) {
    return { ok: false, reason: 'sale_sale_id_required' };
  }
  if (!String(input.leadId || '').trim()) {
    return { ok: false, reason: 'sale_lead_id_required' };
  }
  if (!String(input.unitId || '').trim()) {
    return { ok: false, reason: 'sale_unit_id_required' };
  }
  if (
    input.value == null ||
    !Number.isFinite(Number(input.value)) ||
    Number(input.value) <= 0
  ) {
    return { ok: false, reason: 'sale_value_required' };
  }
  const currency = normalizeCurrency(input.currency);
  if (!currency) {
    return { ok: false, reason: 'sale_currency_required_iso4217' };
  }
  return { ok: true };
}

/** InitiateCheckout = interés especial en una unidad concreta (guardar, precio, entrada…). */
export function gateInitiateCheckout(input: {
  actionSource: string;
  unitId?: string | null;
}): MeasurementGateResult {
  const source = String(input.actionSource || '').trim();
  if (source !== 'website' && source !== 'business_messaging') {
    return { ok: false, reason: 'initiate_checkout_website_or_whatsapp_only' };
  }
  if (!String(input.unitId || '').trim()) {
    return { ok: false, reason: 'initiate_checkout_unit_id_required' };
  }
  return { ok: true };
}

/** Search = búsqueda o listado de unidades en la web; content_ids = resultados. */
export function gateSearch(input: {
  actionSource: string;
  contentIds?: string[] | null;
}): MeasurementGateResult {
  if (String(input.actionSource || '').trim() !== 'website') {
    return { ok: false, reason: 'search_website_only' };
  }
  const ids = (input.contentIds || []).filter((id) => String(id).trim());
  if (!ids.length) {
    return { ok: false, reason: 'search_content_ids_required' };
  }
  if (ids.length > SEARCH_MAX_CONTENT_IDS) {
    return { ok: false, reason: 'search_too_many_content_ids' };
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
  eventName?: string | null;
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
    input.contentType === 'home_listing'
      ? ('home_listing' as const)
      : undefined;

  // Search: las unidades del listado (sin inventar); siempre catálogo inmobiliario.
  if (input.eventName === 'Search') {
    const ids = producerIds
      ? [...new Set(producerIds.map((id) => String(id).trim()).filter(Boolean))]
      : undefined;
    return ids?.length
      ? { contentType: 'home_listing', contentIds: ids }
      : { contentType: producerType, contentIds: undefined };
  }

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

/**
 * Catálogo inmobiliario: exige unit_id y content_ids=[unit_id] si hay
 * home_listing. Excepción: Search lleva varias unidades (sus resultados).
 */
export function gateHomeListingContent(input: {
  contentType?: string | null;
  contentIds?: string[] | null;
  unitId?: string | null;
  eventName?: string | null;
}): MeasurementGateResult {
  if (input.contentType !== 'home_listing') return { ok: true };
  if (input.eventName === 'Search') {
    const count = Array.isArray(input.contentIds) ? input.contentIds.length : 0;
    return count > 0 && count <= SEARCH_MAX_CONTENT_IDS
      ? { ok: true }
      : { ok: false, reason: 'search_content_ids_required' };
  }
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

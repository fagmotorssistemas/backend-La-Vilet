/**
 * Corte de activación Purchase (sin I/O).
 *
 * Elegibilidad exige AMBAS evidencias existentes (no inventadas):
 * - registered_at: cuándo se registró el cierre en CRM
 * - sale_at: fecha de confirmación comercial ya registrada en el cierre
 *
 * Un histórico cargado después del corte (registered_at reciente + sale_at antiguo)
 * queda fuera. No se reescriben fechas.
 */
export function parsePurchaseActivatedAtMs(
  raw: string | null | undefined,
): number | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export function parseExistingTimestampMs(
  raw: string | number | Date | null | undefined,
): number | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return raw > 1e12 ? raw : raw * 1000;
  }
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

export function isPurchaseEligibleAfterActivation(input: {
  registeredAtMs: number | null | undefined;
  /** Confirmación comercial existente (p. ej. sale_at del cierre). No inventar. */
  commercialConfirmedAtMs: number | null | undefined;
  activatedAtMs: number | null | undefined;
}): boolean {
  const cut = input.activatedAtMs;
  if (cut == null || !Number.isFinite(cut)) return false;
  const reg = input.registeredAtMs;
  const confirmed = input.commercialConfirmedAtMs;
  if (reg == null || !Number.isFinite(reg)) return false;
  if (confirmed == null || !Number.isFinite(confirmed)) return false;
  return reg >= cut && confirmed >= cut;
}

export type PurchaseActivationGate =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'purchase_activation_cutover_required'
        | 'purchase_registered_at_required'
        | 'purchase_sale_at_required'
        | 'purchase_event_time_required'
        | 'purchase_event_time_mismatch'
        | 'purchase_before_activation_cutover';
    };

export function evaluatePurchaseActivationGate(input: {
  registeredAt: unknown;
  saleAt: unknown;
  eventTime: unknown;
  activatedAt: unknown;
}): PurchaseActivationGate {
  const cut = parsePurchaseActivatedAtMs(
    typeof input.activatedAt === 'string' ? input.activatedAt : null,
  );
  if (cut == null) {
    return { ok: false, reason: 'purchase_activation_cutover_required' };
  }
  const registeredAtMs = parseExistingTimestampMs(
    input.registeredAt as string | number | Date | null | undefined,
  );
  if (registeredAtMs == null) {
    return { ok: false, reason: 'purchase_registered_at_required' };
  }
  const saleAtMs = parseExistingTimestampMs(
    input.saleAt as string | number | Date | null | undefined,
  );
  if (saleAtMs == null) {
    return { ok: false, reason: 'purchase_sale_at_required' };
  }
  const eventTime =
    typeof input.eventTime === 'number' && Number.isInteger(input.eventTime)
      ? input.eventTime
      : null;
  if (eventTime == null || eventTime < 1_000_000_000) {
    return { ok: false, reason: 'purchase_event_time_required' };
  }
  if (eventTime !== Math.floor(saleAtMs / 1000)) {
    return { ok: false, reason: 'purchase_event_time_mismatch' };
  }
  return isPurchaseEligibleAfterActivation({
    registeredAtMs,
    commercialConfirmedAtMs: saleAtMs,
    activatedAtMs: cut,
  })
    ? { ok: true }
    : { ok: false, reason: 'purchase_before_activation_cutover' };
}

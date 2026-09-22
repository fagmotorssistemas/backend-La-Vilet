/**
 * Corte de activación Purchase (sin I/O).
 * Elegibilidad por momento de registro/confirmación, no por sale_at backdateable.
 */
export function parsePurchaseActivatedAtMs(
  raw: string | null | undefined,
): number | null {
  const v = String(raw || '').trim()
  if (!v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

export function isPurchaseRegisteredAfterActivation(input: {
  registeredAtMs: number | null | undefined
  activatedAtMs: number | null | undefined
}): boolean {
  const reg = input.registeredAtMs
  const cut = input.activatedAtMs
  if (cut == null || !Number.isFinite(cut)) return false
  if (reg == null || !Number.isFinite(reg)) return false
  return reg >= cut
}

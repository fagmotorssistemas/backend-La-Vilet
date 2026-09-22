/**
 * Decisión de anulación Purchase (sin I/O).
 * Fuente CRM: unit_sales_closings + contracts.status === 'anulado'.
 */
export type PurchaseAnnulmentDecision =
  | { action: 'allow_send' }
  | { action: 'cancel'; reason: 'contract_anulado' | 'sale_missing' }
  | { action: 'hold_retry'; reason: 'sale_lookup_transient' }
  | {
      action: 'annotate_after_accept'
      reason: 'annulled_after_meta_accepted'
    }

export type PurchaseSaleSnapshot = {
  saleId: string
  contractId: string | null
  contractStatus: string | null
  /** true si la fila outbox Nest ya está sent con evidencia Graph. */
  nestAlreadyAccepted: boolean
}

/**
 * - Anulado antes de enviar → cancel
 * - Lookup CRM no disponible (transitorio) → hold/retry sin Graph
 * - Ya aceptado por Meta → conservar evidencia; solo anotar
 * - Venta inexistente estable → cancel (no inventar Purchase)
 */
export function decidePurchaseAnnulment(
  input: PurchaseSaleSnapshot | null,
  opts?: { lookupFailed?: boolean },
): PurchaseAnnulmentDecision {
  if (opts?.lookupFailed) {
    return { action: 'hold_retry', reason: 'sale_lookup_transient' }
  }
  if (!input || !String(input.saleId || '').trim()) {
    return { action: 'cancel', reason: 'sale_missing' }
  }
  const status = String(input.contractStatus || '')
    .trim()
    .toLowerCase()
  if (status === 'anulado') {
    if (input.nestAlreadyAccepted) {
      return {
        action: 'annotate_after_accept',
        reason: 'annulled_after_meta_accepted',
      }
    }
    return { action: 'cancel', reason: 'contract_anulado' }
  }
  return { action: 'allow_send' }
}

export function saleIdFromPurchaseRow(row: {
  idempotency_key?: string | null
  payload_redacted?: string | null
}): string | null {
  const key = String(row.idempotency_key || '')
  const m = /^purchase:(.+)$/i.exec(key)
  if (m?.[1]) return m[1].trim() || null
  if (!row.payload_redacted) return null
  try {
    const parsed = JSON.parse(row.payload_redacted) as Record<string, unknown>
    const sale = String(parsed.sale_id || '').trim()
    return sale || null
  } catch {
    return null
  }
}

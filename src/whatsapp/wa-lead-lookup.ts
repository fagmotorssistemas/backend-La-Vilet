/**
 * Candidatos de lookup lead↔WA (CRM usa E.164 con "+", Meta envía dígitos).
 * Sin inventar números: solo variantes del mismo wa_id.
 */
export function waLeadLookupCandidates(
  waIdNormalized: string | null,
  waIdRaw: string,
): string[] {
  const out = new Set<string>()
  const add = (raw: string | null | undefined) => {
    const text = String(raw || '').trim()
    if (!text) return
    out.add(text)
    const digits = text.replace(/\D/g, '')
    if (!digits) return
    out.add(digits)
    out.add(`+${digits}`)
  }
  add(waIdNormalized)
  add(waIdRaw)
  return [...out]
}

/** Valor PostgREST seguro (evita que "+" se interprete como espacio en query). */
export function quotePostgrestEqValue(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

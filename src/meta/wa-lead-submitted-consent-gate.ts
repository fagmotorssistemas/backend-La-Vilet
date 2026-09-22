/**
 * Gate de consentimiento para LeadSubmitted (WhatsApp BM) antes del envío efectivo.
 * Fuente autorizada: fila `leads` en Supabase (meta_ads_consent).
 * Configuración operativa: solo `=== false` cancela (rechazo/revocación).
 * null / ausente permiten envío. No escribe ni inventa consentimiento.
 * Otros eventos CAPI no usan este gate.
 */

export type WaLeadSubmittedConsentAction =
  | 'allow_send'
  | 'cancel_revoked'
  | 'hold_pending'

export type WaLeadSubmittedConsentDecision = {
  action: WaLeadSubmittedConsentAction
  reason: string
}

export type WaLeadSubmittedConsentSnapshot = {
  /** Resultado HTTP / consulta a la fuente autorizada. */
  queryOk: boolean
  /** true si hay fila lead. */
  leadFound: boolean
  metaAdsConsent: boolean | null | undefined
  leadTenantId?: string | null
  leadProjectId?: string | null
  /** Scope del evento (payload / outbox). */
  eventTenantId?: string | null
  eventProjectId?: string | null
  eventContactId?: string | null
}

function normId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function scopeMismatch(
  eventId: string | null,
  leadId: string | null,
): boolean {
  if (!eventId || !leadId) return false
  return eventId !== leadId
}

/**
 * - false → cancel (revocado)
 * - true / null / undefined → allow_send (si scope OK)
 * - error de consulta, sin contacto, lead ausente, scope mismatch → hold
 */
export function decideWaLeadSubmittedConsentGate(
  input: WaLeadSubmittedConsentSnapshot,
): WaLeadSubmittedConsentDecision {
  const contactId = normId(input.eventContactId)
  if (!contactId) {
    return { action: 'hold_pending', reason: 'contact_scope_required' }
  }

  if (!input.queryOk) {
    return { action: 'hold_pending', reason: 'ads_consent_query_error' }
  }

  if (!input.leadFound) {
    return { action: 'hold_pending', reason: 'ads_consent_lead_absent' }
  }

  const eventTenant = normId(input.eventTenantId)
  const eventProject = normId(input.eventProjectId)
  const leadTenant = normId(input.leadTenantId)
  const leadProject = normId(input.leadProjectId)

  if (scopeMismatch(eventTenant, leadTenant)) {
    return { action: 'hold_pending', reason: 'tenant_scope_mismatch' }
  }
  if (scopeMismatch(eventProject, leadProject)) {
    return { action: 'hold_pending', reason: 'project_scope_mismatch' }
  }

  if (input.metaAdsConsent === false) {
    return { action: 'cancel_revoked', reason: 'ads_consent_false' }
  }

  return {
    action: 'allow_send',
    reason:
      input.metaAdsConsent === true
        ? 'ads_consent_true'
        : 'ads_consent_absent_allowed',
  }
}

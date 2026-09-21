import { normalizePhoneE164Digits } from '../common/utils/hash'

export type WaCloudReferral = {
  ctwaClid: string
  sourceId: string | null
  sourceUrl: string | null
  sourceType: string | null
  fieldPath: string
}

export type WaCloudInboundMessage = {
  wamid: string
  waIdRaw: string
  waIdNormalized: string | null
  timestamp: string | null
  referral: WaCloudReferral | null
}

export type WaCloudParsedChange = {
  wabaId: string
  phoneNumberId: string
  displayPhoneNumber: string | null
  messages: WaCloudInboundMessage[]
}

export type WaCloudParseResult =
  | { ok: true; changes: WaCloudParsedChange[] }
  | { ok: false; reason: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text || null
}

function cleanClid(raw: unknown): string | null {
  const value = asString(raw)
  if (!value || value.length > 512) return null
  if (/^(null|undefined|none|n\/a)$/i.test(value)) return null
  return value
}

function parseReferral(
  message: Record<string, unknown>,
): WaCloudReferral | null {
  const referral = asRecord(message.referral)
  if (!referral) return null
  const ctwaClid = cleanClid(referral.ctwa_clid ?? referral.ctwaClid)
  if (!ctwaClid) return null
  return {
    ctwaClid,
    sourceId: asString(referral.source_id ?? referral.sourceId),
    sourceUrl: asString(referral.source_url ?? referral.sourceUrl)?.slice(0, 2000) ?? null,
    sourceType: asString(referral.source_type ?? referral.sourceType)?.slice(0, 64) ?? null,
    fieldPath: 'messages[].referral.ctwa_clid',
  }
}

/**
 * Extrae mensajes inbound del payload Cloud API (object=whatsapp_business_account).
 * No inventa referral: solo si Meta lo envía con ctwa_clid.
 */
export function parseWhatsAppCloudWebhookBody(
  body: unknown,
): WaCloudParseResult {
  const root = asRecord(body)
  if (!root) return { ok: false, reason: 'body_not_object' }
  if (root.object !== 'whatsapp_business_account') {
    return { ok: false, reason: 'unexpected_object' }
  }
  const entry = Array.isArray(root.entry) ? root.entry : []
  if (!entry.length) return { ok: false, reason: 'entry_empty' }

  const changes: WaCloudParsedChange[] = []
  for (const entryItem of entry) {
    const entryRec = asRecord(entryItem)
    if (!entryRec) continue
    const wabaId = asString(entryRec.id)
    if (!wabaId) continue
    const changeList = Array.isArray(entryRec.changes) ? entryRec.changes : []
    for (const change of changeList) {
      const changeRec = asRecord(change)
      if (!changeRec) continue
      if (changeRec.field && changeRec.field !== 'messages') continue
      const value = asRecord(changeRec.value)
      if (!value) continue
      const metadata = asRecord(value.metadata)
      const phoneNumberId = asString(metadata?.phone_number_id)
      if (!phoneNumberId) continue
      const displayPhoneNumber = asString(metadata?.display_phone_number)
      const messagesRaw = Array.isArray(value.messages) ? value.messages : []
      const messages: WaCloudInboundMessage[] = []
      for (const msg of messagesRaw) {
        const msgRec = asRecord(msg)
        if (!msgRec) continue
        const wamid = asString(msgRec.id)
        const waIdRaw = asString(msgRec.from)
        if (!wamid || !waIdRaw) continue
        messages.push({
          wamid,
          waIdRaw,
          waIdNormalized: normalizePhoneE164Digits(waIdRaw),
          timestamp: asString(msgRec.timestamp),
          referral: parseReferral(msgRec),
        })
      }
      // statuses[] u otros: no son inbound de usuario; se ignoran sin error.
      if (!messages.length && Array.isArray(value.statuses)) continue
      changes.push({
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
        messages,
      })
    }
  }

  return { ok: true, changes }
}

export function assertWabaAndPhone(input: {
  wabaId: string
  phoneNumberId: string
  expectedWabaId: string
  expectedPhoneNumberId: string
}): { ok: true } | { ok: false; reason: string } {
  const expectedWaba = String(input.expectedWabaId || '').trim()
  const expectedPhone = String(input.expectedPhoneNumberId || '').trim()
  if (!expectedWaba || !expectedPhone) {
    return { ok: false, reason: 'waba_or_phone_config_missing' }
  }
  if (input.wabaId !== expectedWaba) {
    return { ok: false, reason: 'waba_mismatch' }
  }
  if (input.phoneNumberId !== expectedPhone) {
    return { ok: false, reason: 'phone_number_id_mismatch' }
  }
  return { ok: true }
}

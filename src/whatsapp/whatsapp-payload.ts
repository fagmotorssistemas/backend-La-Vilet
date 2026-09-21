import { normalizePhoneE164Digits } from '../common/utils/hash'

export type WaCloudReferral = {
  ctwaClid: string
  sourceId: string | null
  sourceUrl: string | null
  sourceType: string | null
  fieldPath: string
}

/**
 * Resultado de extracción CTWA sin valores sensibles.
 * Distingue ausencia de bloque referral vs clid ausente/rechazado vs OK.
 */
export type CtwaExtractStatus =
  | 'no_referral_object'
  | 'clid_absent'
  | 'clid_rejected'
  | 'extracted'

export type CtwaExtractDiag = {
  status: CtwaExtractStatus
  referral_object_present: boolean
  /** true si existe clave ctwa_clid o ctwaClid (valor no se guarda aquí). */
  ctwa_clid_key_present: boolean
  source_type_key_present: boolean
  source_id_key_present: boolean
}

export type WaCloudInboundMessage = {
  wamid: string
  waIdRaw: string
  waIdNormalized: string | null
  timestamp: string | null
  referral: WaCloudReferral | null
  ctwaExtract: CtwaExtractDiag
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

function cleanClid(raw: unknown): {
  clid: string | null
  rejected: boolean
  keyHadValue: boolean
} {
  if (raw === undefined || raw === null) {
    return { clid: null, rejected: false, keyHadValue: false }
  }
  const value = asString(raw)
  if (!value) {
    return { clid: null, rejected: true, keyHadValue: true }
  }
  if (value.length > 512) {
    return { clid: null, rejected: true, keyHadValue: true }
  }
  if (/^(null|undefined|none|n\/a)$/i.test(value)) {
    return { clid: null, rejected: true, keyHadValue: true }
  }
  return { clid: value, rejected: false, keyHadValue: true }
}

/**
 * Parsea referral. No inventa CTWA.
 * Devuelve diag aunque referral sea null (para distinguir causas de seen_no_referral).
 */
export function parseReferral(message: Record<string, unknown>): {
  referral: WaCloudReferral | null
  extract: CtwaExtractDiag
} {
  const referral = asRecord(message.referral)
  if (!referral) {
    return {
      referral: null,
      extract: {
        status: 'no_referral_object',
        referral_object_present: false,
        ctwa_clid_key_present: false,
        source_type_key_present: false,
        source_id_key_present: false,
      },
    }
  }

  const clidKeyPresent =
    Object.prototype.hasOwnProperty.call(referral, 'ctwa_clid') ||
    Object.prototype.hasOwnProperty.call(referral, 'ctwaClid')
  const sourceTypeKeyPresent =
    Object.prototype.hasOwnProperty.call(referral, 'source_type') ||
    Object.prototype.hasOwnProperty.call(referral, 'sourceType')
  const sourceIdKeyPresent =
    Object.prototype.hasOwnProperty.call(referral, 'source_id') ||
    Object.prototype.hasOwnProperty.call(referral, 'sourceId')

  const cleaned = cleanClid(referral.ctwa_clid ?? referral.ctwaClid)
  if (!cleaned.clid) {
    const status: CtwaExtractStatus =
      !clidKeyPresent || !cleaned.keyHadValue ? 'clid_absent' : 'clid_rejected'
    return {
      referral: null,
      extract: {
        status,
        referral_object_present: true,
        ctwa_clid_key_present: clidKeyPresent,
        source_type_key_present: sourceTypeKeyPresent,
        source_id_key_present: sourceIdKeyPresent,
      },
    }
  }

  return {
    referral: {
      ctwaClid: cleaned.clid,
      sourceId: asString(referral.source_id ?? referral.sourceId),
      sourceUrl:
        asString(referral.source_url ?? referral.sourceUrl)?.slice(0, 2000) ??
        null,
      sourceType:
        asString(referral.source_type ?? referral.sourceType)?.slice(0, 64) ??
        null,
      fieldPath: 'messages[].referral.ctwa_clid',
    },
    extract: {
      status: 'extracted',
      referral_object_present: true,
      ctwa_clid_key_present: true,
      source_type_key_present: sourceTypeKeyPresent,
      source_id_key_present: sourceIdKeyPresent,
    },
  }
}

/**
 * Extrae mensajes inbound del payload Cloud API (object=whatsapp_business_account).
 * No inventa referral: solo si Meta lo envía con ctwa_clid usable.
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
        const { referral, extract } = parseReferral(msgRec)
        messages.push({
          wamid,
          waIdRaw,
          waIdNormalized: normalizePhoneE164Digits(waIdRaw),
          timestamp: asString(msgRec.timestamp),
          referral,
          ctwaExtract: extract,
        })
      }
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

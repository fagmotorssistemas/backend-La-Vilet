import { createHmac, timingSafeEqual } from 'crypto'

export type MetaHubSignatureDiag = {
  /** Solo presencia; nunca el valor del secreto. */
  app_secret_configured: boolean
  /** Header X-Hub-Signature-256 presente (sin valor). */
  signature_header_present: boolean
  /** Coincide con sha256=<64 hex> (sin revelar el hex). */
  signature_header_sha256_format: boolean
  /** Longitud del body crudo usado en HMAC. */
  raw_body_bytes: number
}

export type MetaHubSignatureResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'app_secret_missing'
        | 'signature_header_invalid'
        | 'signature_mismatch'
      diag: MetaHubSignatureDiag
    }

function rawBodyBytes(rawBody: Buffer | string): number {
  return typeof rawBody === 'string'
    ? Buffer.byteLength(rawBody, 'utf8')
    : rawBody.length
}

function rawBodyBuffer(rawBody: Buffer | string): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
}

/**
 * Valida X-Hub-Signature-256 de Meta sobre el body crudo (Buffer/string original).
 * Formato header: sha256=<hex>
 * Usa el App Secret de la app Meta (META_WA_APP_SECRET en Nest).
 */
export function verifyMetaHubSignature256(input: {
  appSecret: string
  rawBody: Buffer | string
  signatureHeader: string | null | undefined
}): MetaHubSignatureResult {
  const secret = String(input.appSecret || '').trim()
  const header = String(input.signatureHeader || '').trim()
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(header)
  const diag: MetaHubSignatureDiag = {
    app_secret_configured: Boolean(secret),
    signature_header_present: Boolean(header),
    signature_header_sha256_format: Boolean(match),
    raw_body_bytes: rawBodyBytes(input.rawBody),
  }

  if (!secret) {
    return { ok: false, reason: 'app_secret_missing', diag }
  }
  if (!match) {
    return { ok: false, reason: 'signature_header_invalid', diag }
  }

  const expectedHex = createHmac('sha256', secret)
    .update(rawBodyBuffer(input.rawBody))
    .digest('hex')
  const provided = Buffer.from(match[1].toLowerCase(), 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'signature_mismatch', diag }
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch', diag }
  }
  return { ok: true }
}

export function signMetaHubBody(
  appSecret: string,
  rawBody: Buffer | string,
): string {
  const hex = createHmac('sha256', String(appSecret))
    .update(rawBodyBuffer(rawBody))
    .digest('hex')
  return `sha256=${hex}`
}

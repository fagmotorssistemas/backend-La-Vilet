import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Valida X-Hub-Signature-256 de Meta sobre el body crudo (Buffer/string original).
 * Formato header: sha256=<hex>
 */
export function verifyMetaHubSignature256(input: {
  appSecret: string
  rawBody: Buffer | string
  signatureHeader: string | null | undefined
}): { ok: true } | { ok: false; reason: string } {
  const secret = String(input.appSecret || '').trim()
  if (!secret) {
    return { ok: false, reason: 'app_secret_missing' }
  }
  const header = String(input.signatureHeader || '').trim()
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(header)
  if (!match) {
    return { ok: false, reason: 'signature_header_invalid' }
  }
  const expectedHex = createHmac('sha256', secret)
    .update(
      typeof input.rawBody === 'string'
        ? Buffer.from(input.rawBody, 'utf8')
        : input.rawBody,
    )
    .digest('hex')
  const provided = Buffer.from(match[1].toLowerCase(), 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: true }
}

export function signMetaHubBody(
  appSecret: string,
  rawBody: Buffer | string,
): string {
  const hex = createHmac('sha256', String(appSecret))
    .update(
      typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody,
    )
    .digest('hex')
  return `sha256=${hex}`
}

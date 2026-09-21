import { signMetaHubBody, verifyMetaHubSignature256 } from './whatsapp-signature'

describe('verifyMetaHubSignature256', () => {
  const secret = 'test-app-secret'
  const body = Buffer.from(
    JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    'utf8',
  )

  it('acepta firma válida sobre body original (META_WA_APP_SECRET)', () => {
    const header = signMetaHubBody(secret, body)
    expect(
      verifyMetaHubSignature256({
        appSecret: secret,
        rawBody: body,
        signatureHeader: header,
      }),
    ).toEqual({ ok: true })
  })

  it('rechaza app_secret ausente con diag seguro', () => {
    const result = verifyMetaHubSignature256({
      appSecret: '',
      rawBody: body,
      signatureHeader: signMetaHubBody(secret, body),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('app_secret_missing')
      expect(result.diag.app_secret_configured).toBe(false)
      expect(result.diag.raw_body_bytes).toBe(body.length)
      expect(result.diag.signature_header_present).toBe(true)
      expect(result.diag.signature_header_sha256_format).toBe(true)
    }
  })

  it('rechaza firma inválida', () => {
    const result = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: body,
      signatureHeader:
        'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('signature_mismatch')
      expect(result.diag.app_secret_configured).toBe(true)
    }
  })

  it('rechaza body alterado (HMAC sobre crudo)', () => {
    const header = signMetaHubBody(secret, body)
    const tampered = Buffer.from(body.toString('utf8') + ' ', 'utf8')
    const result = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: tampered,
      signatureHeader: header,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  it('rechaza header ausente o mal formado', () => {
    const missing = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: body,
      signatureHeader: null,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.reason).toBe('signature_header_invalid')
      expect(missing.diag.signature_header_present).toBe(false)
    }

    const bad = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: body,
      signatureHeader: 'sha1=dead',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toBe('signature_header_invalid')
      expect(bad.diag.signature_header_sha256_format).toBe(false)
    }
  })
})

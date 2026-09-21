import { signMetaHubBody, verifyMetaHubSignature256 } from './whatsapp-signature'

describe('verifyMetaHubSignature256', () => {
  const secret = 'test-app-secret'
  const body = Buffer.from(
    JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    'utf8',
  )

  it('acepta firma válida sobre body original', () => {
    const header = signMetaHubBody(secret, body)
    expect(verifyMetaHubSignature256({ appSecret: secret, rawBody: body, signatureHeader: header })).toEqual(
      { ok: true },
    )
  })

  it('rechaza firma inválida', () => {
    const result = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: body,
      signatureHeader: 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  it('rechaza body alterado', () => {
    const header = signMetaHubBody(secret, body)
    const tampered = Buffer.from(body.toString('utf8') + ' ', 'utf8')
    const result = verifyMetaHubSignature256({
      appSecret: secret,
      rawBody: tampered,
      signatureHeader: header,
    })
    expect(result.ok).toBe(false)
  })

  it('rechaza header ausente o mal formado', () => {
    expect(
      verifyMetaHubSignature256({
        appSecret: secret,
        rawBody: body,
        signatureHeader: null,
      }).ok,
    ).toBe(false)
    expect(
      verifyMetaHubSignature256({
        appSecret: secret,
        rawBody: body,
        signatureHeader: 'sha1=dead',
      }).ok,
    ).toBe(false)
  })
})

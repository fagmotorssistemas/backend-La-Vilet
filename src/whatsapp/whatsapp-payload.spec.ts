import {
  assertWabaAndPhone,
  parseWhatsAppCloudWebhookBody,
} from './whatsapp-payload'

const WABA = '1410020224338488'
const PHONE = '1372191202637500'

function metaPayload(opts: {
  wabaId?: string
  phoneNumberId?: string
  wamid?: string
  from?: string
  withReferral?: boolean
}) {
  const message: Record<string, unknown> = {
    from: opts.from || '593999999999',
    id: opts.wamid || 'wamid.TEST001',
    timestamp: '1690000000',
    type: 'text',
    text: { body: 'Hola' },
  }
  if (opts.withReferral) {
    message.referral = {
      source_type: 'ad',
      source_id: '120',
      source_url: 'https://fb.me/x',
      ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0',
    }
  }
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: opts.wabaId || WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '593925286',
                phone_number_id: opts.phoneNumberId || PHONE,
              },
              contacts: [{ wa_id: opts.from || '593999999999', profile: { name: 'X' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  }
}

describe('parseWhatsAppCloudWebhookBody', () => {
  it('extrae referral.ctwa_clid solo cuando viene informado', () => {
    const withRef = parseWhatsAppCloudWebhookBody(metaPayload({ withReferral: true }))
    expect(withRef.ok).toBe(true)
    if (!withRef.ok) return
    expect(withRef.changes[0].messages[0].referral?.ctwaClid).toMatch(/^ARA/)
    expect(withRef.changes[0].messages[0].referral?.fieldPath).toBe(
      'messages[].referral.ctwa_clid',
    )

    const without = parseWhatsAppCloudWebhookBody(metaPayload({ withReferral: false }))
    expect(without.ok).toBe(true)
    if (!without.ok) return
    expect(without.changes[0].messages[0].referral).toBeNull()
  })

  it('no inventa CTWA si referral vacío', () => {
    const body = metaPayload({ withReferral: true })
    ;(body.entry[0].changes[0].value.messages[0] as { referral: object }).referral = {}
    const parsed = parseWhatsAppCloudWebhookBody(body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.changes[0].messages[0].referral).toBeNull()
  })
})

describe('assertWabaAndPhone', () => {
  it('acepta WABA/phone esperados', () => {
    expect(
      assertWabaAndPhone({
        wabaId: WABA,
        phoneNumberId: PHONE,
        expectedWabaId: WABA,
        expectedPhoneNumberId: PHONE,
      }),
    ).toEqual({ ok: true })
  })

  it('rechaza WABA incorrecta', () => {
    const r = assertWabaAndPhone({
      wabaId: '999',
      phoneNumberId: PHONE,
      expectedWabaId: WABA,
      expectedPhoneNumberId: PHONE,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('waba_mismatch')
  })
})

import {
  assertWabaAndPhone,
  parseReferral,
  parseWhatsAppCloudWebhookBody,
} from './whatsapp-payload'

const WABA = '1410020224338488'
const PHONE = '1372191202637500'

function metaPayload(opts: {
  wabaId?: string
  phoneNumberId?: string
  wamid?: string
  from?: string
  referral?: Record<string, unknown> | null | undefined
}) {
  const message: Record<string, unknown> = {
    from: opts.from || '593999999999',
    id: opts.wamid || 'wamid.TEST001',
    timestamp: '1690000000',
    type: 'text',
    text: { body: 'Hola' },
  }
  if (opts.referral !== undefined) {
    if (opts.referral !== null) message.referral = opts.referral
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
              contacts: [
                { wa_id: opts.from || '593999999999', profile: { name: 'X' } },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  }
}

const SAMPLE_CLID =
  'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0'

describe('parseReferral / ctwa extract diag', () => {
  it('no_referral_object cuando no hay bloque referral', () => {
    const { referral, extract } = parseReferral({
      id: 'wamid.1',
      from: '5939',
    })
    expect(referral).toBeNull()
    expect(extract).toEqual({
      status: 'no_referral_object',
      referral_object_present: false,
      ctwa_clid_key_present: false,
      source_type_key_present: false,
      source_id_key_present: false,
    })
  })

  it('clid_absent cuando referral existe sin ctwa_clid', () => {
    const { referral, extract } = parseReferral({
      referral: { source_type: 'ad', source_id: '120' },
    })
    expect(referral).toBeNull()
    expect(extract.status).toBe('clid_absent')
    expect(extract.referral_object_present).toBe(true)
    expect(extract.ctwa_clid_key_present).toBe(false)
    expect(extract.source_type_key_present).toBe(true)
    expect(extract.source_id_key_present).toBe(true)
  })

  it('clid_absent cuando ctwa_clid es null explícito', () => {
    const { extract } = parseReferral({
      referral: { ctwa_clid: null, source_type: 'ad' },
    })
    expect(extract.status).toBe('clid_absent')
    expect(extract.ctwa_clid_key_present).toBe(true)
  })

  it('clid_rejected cuando ctwa_clid es placeholder', () => {
    const { referral, extract } = parseReferral({
      referral: { ctwa_clid: 'n/a', source_type: 'ad' },
    })
    expect(referral).toBeNull()
    expect(extract.status).toBe('clid_rejected')
    expect(extract.ctwa_clid_key_present).toBe(true)
  })

  it('extracted cuando hay ctwa_clid usable', () => {
    const { referral, extract } = parseReferral({
      referral: {
        source_type: 'ad',
        source_id: '120',
        ctwa_clid: SAMPLE_CLID,
      },
    })
    expect(referral?.ctwaClid).toBe(SAMPLE_CLID)
    expect(extract.status).toBe('extracted')
    expect(extract.referral_object_present).toBe(true)
    expect(extract.ctwa_clid_key_present).toBe(true)
  })
})

describe('parseWhatsAppCloudWebhookBody', () => {
  it('propaga extract diag en el mensaje', () => {
    const withRef = parseWhatsAppCloudWebhookBody(
      metaPayload({
        referral: {
          source_type: 'ad',
          source_id: '120',
          source_url: 'https://fb.me/x',
          ctwa_clid: SAMPLE_CLID,
        },
      }),
    )
    expect(withRef.ok).toBe(true)
    if (!withRef.ok) return
    expect(withRef.changes[0].messages[0].referral?.ctwaClid).toMatch(/^ARA/)
    expect(withRef.changes[0].messages[0].ctwaExtract.status).toBe('extracted')

    const without = parseWhatsAppCloudWebhookBody(
      metaPayload({ referral: undefined }),
    )
    expect(without.ok).toBe(true)
    if (!without.ok) return
    expect(without.changes[0].messages[0].referral).toBeNull()
    expect(without.changes[0].messages[0].ctwaExtract.status).toBe(
      'no_referral_object',
    )
  })

  it('referral vacío → clid_absent (no inventa CTWA)', () => {
    const parsed = parseWhatsAppCloudWebhookBody(metaPayload({ referral: {} }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.changes[0].messages[0].referral).toBeNull()
    expect(parsed.changes[0].messages[0].ctwaExtract.status).toBe('clid_absent')
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

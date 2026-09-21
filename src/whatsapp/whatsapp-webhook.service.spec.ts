import { ConfigService } from '@nestjs/config'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DatabaseService } from '../database/database.service'
import { WhatsappWebhookService } from './whatsapp-webhook.service'

const WABA = '1410020224338488'
const PHONE = '1372191202637500'

function metaBody(opts: {
  wamid: string
  from?: string
  wabaId?: string
  phoneNumberId?: string
  ctwaClid?: string | null
}) {
  const message: Record<string, unknown> = {
    from: opts.from || '593987654321',
    id: opts.wamid,
    timestamp: '1690000000',
    type: 'text',
    text: { body: 'Interés comercial' },
  }
  if (opts.ctwaClid) {
    message.referral = {
      source_type: 'ad',
      source_id: '1',
      ctwa_clid: opts.ctwaClid,
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
                phone_number_id: opts.phoneNumberId || PHONE,
                display_phone_number: '593925286',
              },
              messages: [message],
            },
          },
        ],
      },
    ],
  }
}

function makeService(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cloud-'))
  const dbPath = path.join(dir, 'test.db')
  env.DATABASE_PATH = dbPath
  const config = {
    get: (key: string) => env[key],
  } as ConfigService
  const db = new DatabaseService(config)
  db.onModuleInit()
  const service = new WhatsappWebhookService(config, db)
  const cleanup = () => {
    try {
      db.onModuleDestroy()
    } catch {
      // ignore
    }
    try {
      cleanup()
    } catch {
      // Windows may keep WAL briefly; ignore.
    }
  }
  return { service, db, cleanup }
}

describe('WhatsappWebhookService', () => {
  const baseEnv = {
    META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED: 'true',
    META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED: 'true',
    META_WA_VERIFY_TOKEN: 'verify-local',
    META_WA_APP_SECRET: 'secret-local',
    META_WABA_ID: WABA,
    META_WA_PHONE_NUMBER_ID: PHONE,
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('GET challenge ok / mismatch', () => {
    const { service, cleanup } = makeService({ ...baseEnv })
    expect(
      service.verifyChallenge({
        mode: 'subscribe',
        verifyToken: 'verify-local',
        challenge: '12345',
      }),
    ).toEqual({ ok: true, challenge: '12345' })
    expect(
      service.verifyChallenge({
        mode: 'subscribe',
        verifyToken: 'wrong',
        challenge: '12345',
      }).ok,
    ).toBe(false)
    cleanup()
  })

  it('RECEIVE off → no éxito silencioso', async () => {
    const { service, cleanup } = makeService({
      ...baseEnv,
      META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED: 'false',
    })
    const result = await service.processSignedWebhook(
      metaBody({ wamid: 'wamid.A', ctwaClid: 'CLID1' }),
    )
    expect(result).toEqual({
      ok: false,
      reason: 'receive_disabled',
      status: 503,
    })
    cleanup()
  })

  it('idempotencia por wamid + CTWA pending sin lead', async () => {
    const { service, db, cleanup } = makeService({ ...baseEnv })
    const body = metaBody({
      wamid: 'wamid.SAME',
      ctwaClid: 'CLID-REAL-1',
      from: '593911111111',
    })
    const first = await service.processSignedWebhook(body)
    const second = await service.processSignedWebhook(body)
    expect(first.ok && first.inserted).toBe(1)
    expect(first.ok && first.pendingLink).toBe(1)
    expect(second.ok && second.duplicates).toBe(1)
    const row = db.getWaCloudReceipt('wamid.SAME')
    expect(row?.has_ctwa).toBe(1)
    expect(row?.link_status).toBe('pending_link')
    expect(row?.ctwa_clid).toBe('CLID-REAL-1')
    cleanup()
  })

  it('WABA incorrecta → 403', async () => {
    const { service, cleanup } = makeService({ ...baseEnv })
    const result = await service.processSignedWebhook(
      metaBody({ wamid: 'wamid.B', wabaId: '000', ctwaClid: 'X' }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'waba_mismatch', status: 403 })
    cleanup()
  })

  it('sin referral: persiste seen_no_referral + extract no_referral_object', async () => {
    const { service, db, cleanup } = makeService({ ...baseEnv })
    const result = await service.processSignedWebhook(
      metaBody({ wamid: 'wamid.NOREF', ctwaClid: null }),
    )
    expect(result.ok && result.noReferral).toBe(1)
    const row = db.getWaCloudReceipt('wamid.NOREF')
    expect(row?.link_status).toBe('seen_no_referral')
    expect(row?.has_ctwa).toBe(0)
    expect(row?.kommo_id).toBeNull()
    expect(row?.lead_id).toBeNull()
    expect(row?.ctwa_extract_status).toBe('no_referral_object')
    expect(row?.referral_object_present).toBe(0)
    cleanup()
  })

  it('correlaciona lead único y llama preserve; ambiguo queda pending', async () => {
    const { service, db, cleanup } = makeService({
      ...baseEnv,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    })
    const fetchMock = jest.spyOn(global, 'fetch' as never) as jest.SpyInstance

    // 1) match único → linked + preserve
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: '11111111-1111-4111-8111-111111111111',
            contact_id: '42',
            kommo_id: 99,
            tenant_id: '22222222-2222-4222-8222-222222222222',
            project_id: '33333333-3333-4333-8333-333333333333',
            whatsapp_id: '593922222222',
            phone_normalized: '593922222222',
          },
        ],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, action: 'inserted' }),
      } as Response)

    const linked = await service.processSignedWebhook(
      metaBody({
        wamid: 'wamid.LINK',
        from: '593922222222',
        ctwaClid: 'CLID-LINK',
      }),
    )
    expect(linked.ok && linked.linked).toBe(1)
    expect(db.getWaCloudReceipt('wamid.LINK')?.link_status).toBe('linked')
    expect(db.getWaCloudReceipt('wamid.LINK')?.supabase_synced).toBe(1)

    // 2) ambiguo
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'a',
          contact_id: '1',
          kommo_id: 1,
          tenant_id: 't',
          project_id: 'p',
          whatsapp_id: '593933333333',
          phone_normalized: '593933333333',
        },
        {
          id: 'b',
          contact_id: '2',
          kommo_id: 2,
          tenant_id: 't',
          project_id: 'p',
          whatsapp_id: '593933333333',
          phone_normalized: '593933333333',
        },
      ],
    } as Response)

    const amb = await service.processSignedWebhook(
      metaBody({
        wamid: 'wamid.AMB',
        from: '593933333333',
        ctwaClid: 'CLID-AMB',
      }),
    )
    expect(amb.ok && amb.pendingLink).toBe(1)
    expect(db.getWaCloudReceipt('wamid.AMB')?.link_status).toBe(
      'pending_ambiguous',
    )

    const preserveCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('lv_app_preserve_ctwa'),
    )
    expect(preserveCalls.length).toBe(1)

    cleanup()
  })

  it('llegada Meta antes que Kommo: pending → reconcile tras lead', async () => {
    const { service, db, cleanup } = makeService({
      ...baseEnv,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    })
    const fetchMock = jest.spyOn(global, 'fetch' as never) as jest.SpyInstance

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    await service.processSignedWebhook(
      metaBody({
        wamid: 'wamid.EARLY',
        from: '593944444444',
        ctwaClid: 'CLID-EARLY',
      }),
    )
    expect(db.getWaCloudReceipt('wamid.EARLY')?.link_status).toBe('pending_link')

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: '44444444-4444-4444-8444-444444444444',
            contact_id: '77',
            kommo_id: 77,
            tenant_id: '55555555-5555-4555-8555-555555555555',
            project_id: '66666666-6666-4666-8666-666666666666',
            whatsapp_id: '593944444444',
            phone_normalized: '593944444444',
          },
        ],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, action: 'inserted' }),
      } as Response)

    const recon = await service.reconcilePending()
    expect(recon.linked).toBe(1)
    expect(db.getWaCloudReceipt('wamid.EARLY')?.link_status).toBe('linked')
    cleanup()
  })
})

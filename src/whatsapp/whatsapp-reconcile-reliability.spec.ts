import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

const WABA = '1410020224338488';
const PHONE = '1372191202637500';
const LEAD = {
  id: '44444444-4444-4444-8444-444444444444',
  contact_id: '77',
  kommo_id: 77,
  tenant_id: '55555555-5555-4555-8555-555555555555',
  project_id: '66666666-6666-4666-8666-666666666666',
  whatsapp_id: null,
  phone_normalized: '+593944444444',
};

function ctwaBody(wamid: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE },
              messages: [
                {
                  from: '593944444444',
                  id: wamid,
                  timestamp: '1790000000',
                  type: 'text',
                  text: { body: 'hola' },
                  referral: {
                    source_type: 'ad',
                    source_id: '1',
                    ctwa_clid: 'CLID-1',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rel-'));
  const env: Record<string, string> = {
    DATABASE_PATH: path.join(dir, 'test.db'),
    META_WA_CTWA_RECONCILE_ENABLED: 'false',
    META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED: 'true',
    META_WA_APP_SECRET: 'secret-local',
    META_WABA_ID: WABA,
    META_WA_PHONE_NUMBER_ID: PHONE,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  };
  const config = { get: (key: string) => env[key] } as ConfigService;
  const db = new DatabaseService(config);
  db.onModuleInit();
  const service = new WhatsappWebhookService(config, db);
  service.onModuleInit();
  const cleanup = () => {
    service.onModuleDestroy();
    db.onModuleDestroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede retener el WAL un instante.
    }
  };
  return { service, db, cleanup };
}

type Mode = { lookup: 'lead' | 'none' | 'throw'; preserve: 'ok' | 'throw' };

function mockSupabase(mode: Mode) {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/leads')) {
        if (mode.lookup === 'throw') throw new Error('ECONNRESET');
        return {
          ok: true,
          status: 200,
          json: async () => (mode.lookup === 'lead' ? [LEAD] : []),
        } as Response;
      }
      if (url.includes('lv_app_preserve_ctwa')) {
        if (mode.preserve === 'throw') throw new Error('ECONNRESET');
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, action: 'preserved' }),
        } as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
}

describe('WhatsApp CTWA — conciliación confiable', () => {
  afterEach(() => jest.restoreAllMocks());

  it('si el CRM falla al guardar el clid, la fila no queda linked y se reintenta', async () => {
    const { service, db, cleanup } = setup();
    const mode: Mode = { lookup: 'lead', preserve: 'throw' };
    mockSupabase(mode);

    const result = await service.processSignedWebhook(ctwaBody('wamid.A'));
    expect(result.ok).toBe(true);
    const failed = db.getWaCloudReceipt('wamid.A')!;
    expect(failed.link_status).toBe('sync_failed');
    expect(failed.supabase_synced).toBe(0);
    expect(failed.last_error).toBe('preserve_network_error');

    mode.preserve = 'ok';
    const recon = await service.reconcilePending();
    expect(recon).toEqual({ tried: 1, linked: 1 });
    const linked = db.getWaCloudReceipt('wamid.A')!;
    expect(linked.link_status).toBe('linked');
    expect(linked.supabase_synced).toBe(1);
    cleanup();
  });

  it('un fallo de red en la búsqueda del lead no devuelve error a Meta', async () => {
    const { service, db, cleanup } = setup();
    mockSupabase({ lookup: 'throw', preserve: 'ok' });

    const result = await service.processSignedWebhook(ctwaBody('wamid.B'));
    expect(result).toMatchObject({ ok: true, processed: 1, pendingLink: 1 });
    expect(db.getWaCloudReceipt('wamid.B')!.last_error).toBe(
      'lead_lookup_failed',
    );
    cleanup();
  });

  it('filas que no casan esperan cada vez más y acaban unlinked_expired', async () => {
    const { service, db, cleanup } = setup();
    mockSupabase({ lookup: 'none', preserve: 'ok' });
    await service.processSignedWebhook(ctwaBody('wamid.C'));

    expect(await service.reconcilePending()).toEqual({ tried: 1, linked: 0 });
    const row = db.getWaCloudReceipt('wamid.C')!;
    expect(row.reconcile_attempts).toBe(1);
    expect(Date.parse(row.next_reconcile_at!)).toBeGreaterThan(Date.now());
    // Hasta que venza la espera no vuelve a intentarse.
    expect(await service.reconcilePending()).toEqual({ tried: 0, linked: 0 });

    for (let i = 0; i < 40; i += 1) {
      db.sqlite.scheduleWaReceiptReconcileRetry('wamid.C');
    }
    expect(db.getWaCloudReceipt('wamid.C')!.link_status).toBe(
      'unlinked_expired',
    );
    expect(db.listPendingWaCloudReceipts(50)).toHaveLength(0);
    cleanup();
  });

  it('recupera filas antiguas que quedaron linked sin sincronizar', async () => {
    const { service, db, cleanup } = setup();
    mockSupabase({ lookup: 'lead', preserve: 'ok' });
    db.insertWaCloudReceipt({
      wamid: 'wamid.LEGACY',
      waIdRaw: '593944444444',
      waIdNormalized: '593944444444',
      phoneNumberId: PHONE,
      wabaId: WABA,
      hasCtwa: true,
      ctwaClid: 'CLID-LEGACY',
      referralSourceType: 'ad',
      sourceId: '1',
      sourceUrl: null,
      fieldPath: null,
      linkStatus: 'linked',
      ctwaExtractStatus: 'extracted',
      referralObjectPresent: true,
      ctwaClidKeyPresent: true,
      messageTimestamp: null,
    });

    expect(await service.reconcilePending()).toEqual({ tried: 1, linked: 1 });
    expect(db.getWaCloudReceipt('wamid.LEGACY')!.supabase_synced).toBe(1);
    cleanup();
  });
});

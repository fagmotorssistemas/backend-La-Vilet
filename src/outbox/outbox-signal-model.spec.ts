import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { OutboxService } from './outbox.service';
import type { EnqueueEventDto } from '../events/dto/enqueue-event.dto';

const LEAD = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';

type GraphCall = { url: string; body: { data: any[] } };

function setup(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-signal-'));
  const values: Record<string, string> = {
    DATABASE_PATH: path.join(dir, 'test.db'),
    META_MODE: 'live',
    META_DATASET_ID: 'WEB_DS',
    META_CAPI_ACCESS_TOKEN: 'web-token',
    META_WA_CAPI_ACCESS_TOKEN: 'wa-token',
    META_WABA_ID: 'WABA_1',
    META_MESSAGING_DATASET_ID: 'MSG_DS',
    OUTBOX_ENABLED: 'false',
    ...env,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  const db = new DatabaseService(config);
  db.onModuleInit();
  const meta = new MetaCapiService(config);
  const events = new EventsService(db, meta);
  const outbox = new OutboxService(db, meta, config);
  const graphCalls: GraphCall[] = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://graph.facebook.com/')) {
      graphCalls.push({ url, body: JSON.parse(String(init?.body)) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ events_received: 1, fbtrace_id: 'TRACE' }),
      } as Response;
    }
    if (url.includes('/rest/v1/leads')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { meta_ads_consent: true, tenant_id: null, project_id: null },
        ],
      } as Response;
    }
    return { ok: true, status: 201, json: async () => ({}) } as Response;
  });
  const cleanup = () => {
    db.onModuleDestroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede retener el WAL.
    }
  };
  return { values, db, events, outbox, graphCalls, cleanup };
}

let seq = 0;
function dto(overrides: Partial<EnqueueEventDto>): EnqueueEventDto {
  seq += 1;
  const id = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    event_name: 'ViewContent',
    idempotency_key: `k:${id}`,
    event_id: id,
    event_time: Math.floor(Date.now() / 1000) - 60,
    action_source: 'website',
    ads_consent: true,
    delivery_lane: 'live',
    lead_id: LEAD,
    ...overrides,
  } as EnqueueEventDto;
}

describe('Outbox — modelo de señales', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Purchase sale con el valor fijo vigente al enviar', async () => {
    const { values, events, outbox, graphCalls, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    const queued = dto({ event_name: 'Purchase', unit_id: UNIT });
    events.enqueue(queued);
    // Cambio de configuración posterior: se envía el valor vigente.
    values.META_QUALIFIED_PURCHASE_VALUE = '6500';
    await outbox.tick();

    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain('/WEB_DS/events');
    expect(graphCalls[0].body.data[0].custom_data).toMatchObject({
      value: 6500,
      currency: 'USD',
      content_ids: [UNIT],
      content_type: 'home_listing',
    });
    expect(db.getLatestByEventId(queued.event_id!)?.status).toBe('sent');
    cleanup();
  });

  it('Purchase con precio del CRM sale con ese precio, no con el respaldo', async () => {
    const { values, events, outbox, graphCalls, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    events.enqueue(
      dto({
        event_name: 'Purchase',
        unit_id: UNIT,
        value: 244966,
        currency: 'USD',
      }),
    );
    values.META_QUALIFIED_PURCHASE_VALUE = '6500';
    await outbox.tick();

    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].body.data[0].custom_data).toMatchObject({
      value: 244966,
      currency: 'USD',
      content_ids: [UNIT],
      content_type: 'home_listing',
    });
    cleanup();
  });

  it('Purchase con precio del CRM sale aunque no haya valor de respaldo', async () => {
    const { events, outbox, graphCalls, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
    });
    events.enqueue(
      dto({ event_name: 'Purchase', value: 132211, currency: 'USD' }),
    );
    await outbox.tick();

    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].body.data[0].custom_data).toMatchObject({
      value: 132211,
      currency: 'USD',
    });
    cleanup();
  });

  it('Purchase sin valor configurado se retiene 1 h sin llamar a Meta', async () => {
    const { events, outbox, graphCalls, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
    });
    const queued = dto({ event_name: 'Purchase' });
    events.enqueue(queued);
    await outbox.tick();

    expect(graphCalls).toHaveLength(0);
    const row = db.getLatestByEventId(queued.event_id!)!;
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('qualified_purchase_value_not_configured');
    expect(Date.parse(row.next_attempt_at!) - Date.now()).toBeGreaterThan(
      3_500_000,
    );
    cleanup();
  });

  it('con la entrega apagada no se reclaman Purchase, VentaCerrada, Search ni InitiateCheckout', async () => {
    const { events, outbox, graphCalls, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    const held = [
      dto({ event_name: 'Purchase' }),
      dto({ event_name: 'Search', content_ids: [UNIT] }),
      dto({ event_name: 'InitiateCheckout', unit_id: UNIT }),
    ];
    for (const item of held) events.enqueue(item);
    const view = dto({ event_name: 'ViewContent', unit_id: UNIT });
    events.enqueue(view);
    await outbox.tick();

    expect(graphCalls.map((c) => c.body.data[0].event_name)).toEqual([
      'ViewContent',
    ]);
    for (const item of held) {
      const row = db.getLatestByEventId(item.event_id!)!;
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
    }
    cleanup();
  });

  it('Purchase por WhatsApp consulta el consentimiento y sale por el dataset de mensajería', async () => {
    const { events, outbox, graphCalls, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    });
    events.enqueue(
      dto({
        event_name: 'Purchase',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'CTWA-1',
        whatsapp_business_account_id: 'WABA_1',
        messaging_dataset_id: 'MSG_DS',
        contact_id: 'contact-1',
      }),
    );
    await outbox.tick();

    const leadLookups = (global.fetch as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('/rest/v1/leads'),
    );
    expect(leadLookups.length).toBeGreaterThan(0);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain('/MSG_DS/events');
    expect(graphCalls[0].body.data[0]).toMatchObject({
      event_name: 'Purchase',
      action_source: 'business_messaging',
      custom_data: { value: 5000, currency: 'USD' },
    });
    cleanup();
  });

  it('Purchase por WhatsApp sin contacto queda retenido (mismo gate que LeadSubmitted)', async () => {
    const { events, outbox, graphCalls, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    });
    const queued = dto({
      event_name: 'Purchase',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      ctwa_clid: 'CTWA-1',
      whatsapp_business_account_id: 'WABA_1',
      messaging_dataset_id: 'MSG_DS',
    });
    events.enqueue(queued);
    await outbox.tick();
    expect(graphCalls).toHaveLength(0);
    expect(db.getLatestByEventId(queued.event_id!)?.last_error).toBe(
      'contact_scope_required',
    );
    cleanup();
  });

  it('Search encendido sale con sus unidades bajo Core Setup', async () => {
    const { events, outbox, graphCalls, cleanup } = setup({
      META_FUNNEL_EVENTS_DELIVERY_ENABLED: 'true',
    });
    events.enqueue(
      dto({ event_name: 'Search', content_ids: [UNIT], content_name: 'x' }),
    );
    await outbox.tick();
    expect(graphCalls[0].body.data[0].custom_data).toEqual({
      content_ids: [UNIT],
      content_type: 'home_listing',
    });
    cleanup();
  });

  it('VentaCerrada respeta el corte META_SALE_ACTIVATED_AT', async () => {
    const { events, outbox, graphCalls, db, cleanup } = setup({
      META_SALE_DELIVERY_ENABLED: 'true',
      META_SALE_ACTIVATED_AT: '2026-10-01T00:00:00.000Z',
    });
    const saleAt = new Date(Date.now() - 3600_000);
    const sale = dto({
      event_name: 'VentaCerrada',
      action_source: 'system_generated',
      idempotency_key: 'venta_cerrada:55555555-5555-4555-8555-555555555555',
      sale_id: '55555555-5555-4555-8555-555555555555',
      unit_id: UNIT,
      value: 150000,
      currency: 'USD',
      registered_at: new Date(Date.now() - 1800_000).toISOString(),
      sale_at: saleAt.toISOString(),
      event_time: Math.floor(saleAt.getTime() / 1000),
    });
    events.enqueue(sale);
    // Sin Supabase la anulación no se puede verificar: se retiene, no se envía.
    await outbox.tick();
    expect(graphCalls).toHaveLength(0);
    expect(db.getLatestByEventId(sale.event_id!)?.last_error).toBe(
      'sale_lookup_transient',
    );
    cleanup();
  });

  it('una fila corrupta no deja el resto del lote en processing', async () => {
    const { events, outbox, graphCalls, db, cleanup } = setup({});
    const broken = dto({ event_name: 'ViewContent', unit_id: UNIT });
    const fine = dto({ event_name: 'Lead' });
    events.enqueue(broken);
    events.enqueue(fine);
    // Acceso directo a SQLite solo en el test para simular un payload corrupto.
    (
      db as unknown as {
        db: { prepare(sql: string): { run(...a: unknown[]): void } };
      }
    ).db
      .prepare(
        `UPDATE outbox_events SET graph_payload = '{roto' WHERE event_id = ?`,
      )
      .run(broken.event_id);
    await outbox.tick();

    expect(db.getLatestByEventId(broken.event_id!)).toMatchObject({
      status: 'pending',
      last_error: 'worker_row_error',
    });
    expect(db.getLatestByEventId(fine.event_id!)?.status).toBe('sent');
    expect(graphCalls).toHaveLength(1);
    cleanup();
  });
});

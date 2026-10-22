import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { EventsService, deterministicUuidV4 } from './events.service';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';

const LEAD = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const UNIT_2 = '33333333-3333-4333-8333-333333333333';
const SALE = '44444444-4444-4444-8444-444444444444';
const TIME = 1_790_300_000;

function setup(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-model-'));
  const values: Record<string, string> = {
    DATABASE_PATH: path.join(dir, 'test.db'),
    META_MODE: 'live',
    META_DATASET_ID: 'WEB_DS',
    META_CAPI_ACCESS_TOKEN: 'web-token',
    META_WA_CAPI_ACCESS_TOKEN: 'wa-token',
    META_WABA_ID: 'WABA_1',
    META_MESSAGING_DATASET_ID: 'MSG_DS',
    ...env,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  const db = new DatabaseService(config);
  db.onModuleInit();
  const meta = new MetaCapiService(config);
  const service = new EventsService(db, meta);
  const graph = (eventId: string) => {
    const row = db.getLatestByEventId(eventId)!;
    return {
      row,
      event: (JSON.parse(row.graph_payload) as { data: any[] }).data[0],
      redacted: JSON.parse(row.payload_redacted) as Record<string, unknown>,
    };
  };
  const cleanup = () => {
    db.onModuleDestroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede retener el WAL.
    }
  };
  return { service, db, graph, cleanup };
}

let seq = 0;
function eventId() {
  seq += 1;
  return `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function web(overrides: Partial<EnqueueEventDto>): EnqueueEventDto {
  return {
    event_name: 'ViewContent',
    idempotency_key: `k:${eventId()}`,
    event_id: eventId(),
    event_time: TIME,
    action_source: 'website',
    ads_consent: true,
    delivery_lane: 'live',
    lead_id: LEAD,
    ...overrides,
  } as EnqueueEventDto;
}

function whatsapp(overrides: Partial<EnqueueEventDto>): EnqueueEventDto {
  return web({
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    ctwa_clid: 'CTWA-1',
    whatsapp_business_account_id: 'WABA_1',
    messaging_dataset_id: 'MSG_DS',
    contact_id: 'contact-1',
    ...overrides,
  });
}

describe('Modelo de señales — Purchase calificado, VentaCerrada y embudo', () => {
  it('Purchase lleva el precio real de la unidad que manda el CRM', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
    });
    const id = eventId();
    const res = service.enqueue(
      web({
        event_name: 'Purchase',
        event_id: id,
        unit_id: UNIT,
        value: 185000.456,
        currency: 'usd',
      }),
    );
    expect(res).toMatchObject({ accepted: true, delivery: 'queued' });
    const { event, row } = graph(id);
    expect(row.dataset_id).toBe('WEB_DS');
    expect(event.custom_data).toEqual({
      value: 185000.46,
      currency: 'USD',
      content_ids: [UNIT],
      content_type: 'home_listing',
    });
    cleanup();
  });

  it('con precio del CRM no hace falta el valor de respaldo', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
    });
    const id = eventId();
    const res = service.enqueue(
      web({
        event_name: 'Purchase',
        event_id: id,
        value: 132211,
        currency: 'USD',
      }),
    );
    expect(res.delivery).toBe('queued');
    expect(graph(id).event.custom_data).toMatchObject({
      value: 132211,
      currency: 'USD',
    });
    cleanup();
  });

  it('un precio inválido no se envía: queda el respaldo para el envío', () => {
    for (const value of [0, -10, 100_000_001, Number.NaN]) {
      const { service, graph, cleanup } = setup({
        META_QUALIFIED_PURCHASE_VALUE: '5000',
        META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
      });
      const id = eventId();
      const res = service.enqueue(
        web({ event_name: 'Purchase', event_id: id, value, currency: 'USD' }),
      );
      expect(res.delivery).toBe('queued');
      expect(graph(id).event.custom_data?.value).toBeUndefined();
      cleanup();
    }
  });

  it('Purchase sin valor configurado se acepta pero queda retenido', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_DELIVERY_ENABLED: 'true',
    });
    const id = eventId();
    const res = service.enqueue(web({ event_name: 'Purchase', event_id: id }));
    expect(res.delivery).toBe('held:qualified_purchase_value_not_configured');
    expect(graph(id).event.custom_data).toBeUndefined();
    cleanup();
  });

  it('Purchase queda retenido mientras su entrega está apagada', () => {
    const { service, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    expect(service.enqueue(web({ event_name: 'Purchase' })).delivery).toBe(
      'held:qualified_purchase_delivery_inactive',
    );
    cleanup();
  });

  it('Purchase con formato de venta (system_generated) se rechaza', () => {
    const { service, cleanup } = setup();
    expect(() =>
      service.enqueue(
        web({ event_name: 'Purchase', action_source: 'system_generated' }),
      ),
    ).toThrow(
      new BadRequestException(
        'purchase_is_qualified_contact_use_venta_cerrada',
      ),
    );
    cleanup();
  });

  it('Purchase por WhatsApp va al dataset de mensajería con ctwa_clid', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    const id = eventId();
    service.enqueue(
      whatsapp({
        event_name: 'Purchase',
        event_id: id,
        value: 285354,
        currency: 'USD',
      }),
    );
    const { event, row } = graph(id);
    expect(row.dataset_id).toBe('MSG_DS');
    expect(event.action_source).toBe('business_messaging');
    expect(event.user_data.ctwa_clid).toBe('CTWA-1');
    expect(event.custom_data).toMatchObject({
      value: 285354,
      currency: 'USD',
    });
    cleanup();
  });

  it('VentaCerrada lleva el importe real y detecta cambios de importe', () => {
    const { service, graph, cleanup } = setup({
      META_SALE_DELIVERY_ENABLED: 'true',
    });
    const id = eventId();
    const sale = web({
      event_name: 'VentaCerrada',
      action_source: 'system_generated',
      event_id: id,
      idempotency_key: `venta_cerrada:${SALE}`,
      sale_id: SALE,
      unit_id: UNIT,
      value: 150128,
      currency: 'usd',
      registered_at: '2026-10-01T10:00:00.000Z',
      sale_at: '2026-10-01T09:00:00.000Z',
    });
    expect(service.enqueue({ ...sale }).delivery).toBe('queued');
    expect(graph(id).event.custom_data).toMatchObject({
      value: 150128,
      currency: 'USD',
      content_ids: [UNIT],
    });
    expect(service.enqueue({ ...sale }).duplicate).toBe(true);
    expect(() => service.enqueue({ ...sale, value: 1 })).toThrow(
      ConflictException,
    );
    cleanup();
  });

  it('Search web envía las unidades del listado; por WhatsApp se rechaza', () => {
    const { service, graph, cleanup } = setup();
    const id = eventId();
    const res = service.enqueue(
      web({ event_name: 'Search', event_id: id, content_ids: [UNIT, UNIT_2] }),
    );
    expect(res.delivery).toBe('held:funnel_events_delivery_inactive');
    expect(graph(id).event.custom_data).toEqual({
      content_ids: [UNIT, UNIT_2],
      content_type: 'home_listing',
    });
    expect(() =>
      service.enqueue(whatsapp({ event_name: 'Search', content_ids: [UNIT] })),
    ).toThrow(/business_messaging_event_not_supported/);
    expect(() => service.enqueue(web({ event_name: 'Search' }))).toThrow(
      /search_content_ids_required/,
    );
    cleanup();
  });

  it('InitiateCheckout exige unidad; por WhatsApp se acepta', () => {
    const { service, graph, cleanup } = setup({
      META_FUNNEL_EVENTS_DELIVERY_ENABLED: 'true',
    });
    expect(() =>
      service.enqueue(web({ event_name: 'InitiateCheckout' })),
    ).toThrow(/initiate_checkout_unit_id_required/);
    const id = eventId();
    expect(
      service.enqueue(
        whatsapp({
          event_name: 'InitiateCheckout',
          event_id: id,
          unit_id: UNIT,
        }),
      ).delivery,
    ).toBe('queued');
    expect(graph(id).row.dataset_id).toBe('MSG_DS');
    cleanup();
  });

  it('ViewContent por WhatsApp queda retenido hasta encender el embudo', () => {
    const { service, cleanup } = setup();
    expect(
      service.enqueue(whatsapp({ event_name: 'ViewContent', unit_id: UNIT }))
        .delivery,
    ).toBe('held:funnel_events_delivery_inactive');
    expect(
      service.enqueue(web({ event_name: 'ViewContent', unit_id: UNIT }))
        .delivery,
    ).toBe('queued');
    cleanup();
  });

  it('Purchase con la misma clave y otra unidad es un conflicto', () => {
    const { service, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    const base = web({ event_name: 'Purchase', unit_id: UNIT });
    service.enqueue({ ...base });
    expect(() => service.enqueue({ ...base, unit_id: UNIT_2 })).toThrow(
      ConflictException,
    );
    cleanup();
  });
});

describe('Cascada de señales', () => {
  it('apagada por defecto: no genera eventos inferiores', () => {
    const { service, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
    });
    const res = service.enqueue(web({ event_name: 'Purchase', unit_id: UNIT }));
    expect(res.cascade).toEqual([]);
    cleanup();
  });

  it('Purchase web con unidad encola InitiateCheckout, ViewContent y Lead', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_SIGNAL_CASCADE_ENABLED: 'true',
    });
    const id = eventId();
    const res = service.enqueue(
      web({
        event_name: 'Purchase',
        event_id: id,
        idempotency_key: `purchase_qualified:${LEAD}:${UNIT}`,
        unit_id: UNIT,
        visitor_key: 'visitor-1',
      }),
    );
    expect(res.cascade.map((c) => c.event_name)).toEqual([
      'InitiateCheckout',
      'ViewContent',
      'Lead',
    ]);
    for (const child of res.cascade) {
      expect(child.event_id).toBe(
        deterministicUuidV4(`cascade:${id}:${child.event_name}`),
      );
      const { row, event, redacted } = graph(child.event_id!);
      expect(row.idempotency_key).toBe(
        `cascade:${child.event_name}:purchase_qualified:${LEAD}:${UNIT}`,
      );
      expect(row.event_time).toBe(TIME);
      expect(row.lead_id).toBe(LEAD);
      expect(event.custom_data?.value).toBeUndefined();
      expect(redacted.cascade_from_event_id).toBe(id);
      expect(redacted.cascade_from_event_name).toBe('Purchase');
    }
    expect(graph(res.cascade[0].event_id!).event.custom_data).toEqual({
      content_ids: [UNIT],
      content_type: 'home_listing',
    });
    cleanup();
  });

  it('Purchase por WhatsApp genera LeadSubmitted, no Lead', () => {
    const { service, graph, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_SIGNAL_CASCADE_ENABLED: 'true',
    });
    const res = service.enqueue(whatsapp({ event_name: 'Purchase' }));
    expect(res.cascade.map((c) => c.event_name)).toEqual(['LeadSubmitted']);
    const child = graph(res.cascade[0].event_id!);
    expect(child.row.dataset_id).toBe('MSG_DS');
    expect(child.event.user_data.ctwa_clid).toBe('CTWA-1');
    cleanup();
  });

  it('no duplica: Lead una vez por lead, ViewContent una vez por unidad cada 24 h', () => {
    const { service, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_FUNNEL_EVENTS_DELIVERY_ENABLED: 'true',
      META_SIGNAL_CASCADE_ENABLED: 'true',
    });
    // El lead ya existía (formulario) y ya vio la unidad hoy.
    service.enqueue(
      web({ event_name: 'Lead', idempotency_key: `lead:${LEAD}` }),
    );
    service.enqueue(web({ event_name: 'ViewContent', unit_id: UNIT }));

    const res = service.enqueue(web({ event_name: 'Purchase', unit_id: UNIT }));
    expect(res.cascade).toEqual([
      expect.objectContaining({
        event_name: 'InitiateCheckout',
        delivery: 'queued',
      }),
      { event_name: 'ViewContent', delivery: 'skipped:already_sent' },
      { event_name: 'Lead', delivery: 'skipped:already_sent' },
    ]);

    // Otra unidad: ViewContent e InitiateCheckout nuevos; Lead sigue siendo único.
    const other = service.enqueue(
      web({ event_name: 'Purchase', unit_id: UNIT_2 }),
    );
    expect(other.cascade.map((c) => [c.event_name, c.delivery])).toEqual([
      ['InitiateCheckout', 'queued'],
      ['ViewContent', 'queued'],
      ['Lead', 'skipped:already_sent'],
    ]);
    cleanup();
  });

  it('un reintento del mismo Purchase no vuelve a generar la cascada', () => {
    const { service, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_SIGNAL_CASCADE_ENABLED: 'true',
    });
    const purchase = web({ event_name: 'Purchase', unit_id: UNIT });
    service.enqueue({ ...purchase });
    const before = db.countsByStatus();
    const retry = service.enqueue({ ...purchase });
    expect(retry.duplicate).toBe(true);
    expect(retry.cascade).toEqual([]);
    expect(db.countsByStatus()).toEqual(before);
    cleanup();
  });

  it('InitiateCheckout encola ViewContent de la misma unidad', () => {
    const { service, cleanup } = setup({ META_SIGNAL_CASCADE_ENABLED: 'true' });
    const res = service.enqueue(
      web({ event_name: 'InitiateCheckout', unit_id: UNIT }),
    );
    expect(res.cascade.map((c) => c.event_name)).toEqual(['ViewContent']);
    cleanup();
  });

  it('con consentimiento revocado no hay cascada', () => {
    const { service, db, cleanup } = setup({
      META_QUALIFIED_PURCHASE_VALUE: '5000',
      META_SIGNAL_CASCADE_ENABLED: 'true',
    });
    db.revokeConsent('lead', LEAD, 1);
    const res = service.enqueue(web({ event_name: 'Purchase', unit_id: UNIT }));
    expect(res.blocked_by_consent).toBe(true);
    expect(res.cascade).toEqual([]);
    cleanup();
  });
});

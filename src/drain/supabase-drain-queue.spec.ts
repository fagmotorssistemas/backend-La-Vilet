import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

type Row = {
  id: string;
  idempotency_key: string;
  event_id: string;
  event_name: string;
  event_time: number;
  payload: Record<string, unknown>;
  status: string;
  delivery_lane: 'test' | 'live';
  lead_id: string | null;
  visitor_key: string | null;
  ads_consent_required: boolean;
  created_at: string;
  last_error?: string | null;
};

const EVENT_TIME = 1_790_000_000;

function uuid(n: number): string {
  return `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n: number, eventName: string, extra: Partial<Row> = {}): Row {
  return {
    id: `row-${String(n).padStart(3, '0')}`,
    idempotency_key: `${eventName.toLowerCase()}:${n}`,
    event_id: uuid(n),
    event_name: eventName,
    event_time: EVENT_TIME,
    payload: { action_source: 'website' },
    status: 'pending',
    delivery_lane: 'live',
    lead_id: null,
    visitor_key: null,
    ads_consent_required: false,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
    ...extra,
  };
}

/** Supabase simulado: respeta status, carril, event_name not.in, orden y cursor. */
function fakeSupabase(store: Row[]) {
  const getUrls: URL[] = [];
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method || 'GET').toUpperCase();
      const json = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url.pathname.includes('/rpc/')) return json({});
      if (url.pathname.endsWith('/meta_ads_consent_ledger')) return json([]);
      if (url.pathname.endsWith('/leads')) {
        // Lead con consentimiento y sin scope (no hay mismatch de tenant/proyecto).
        return json([
          { meta_ads_consent: true, tenant_id: null, project_id: null },
        ]);
      }
      if (!url.pathname.endsWith('/meta_capi_outbox')) return json([]);

      if (method === 'PATCH') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        const target = store.find((r) => r.id === id);
        if (!target) return json([]);
        Object.assign(target, JSON.parse(String(init?.body)));
        return json([target]);
      }

      getUrls.push(url);
      const status = url.searchParams.get('status')?.replace(/^eq\./, '');
      const lane = url.searchParams.get('delivery_lane')?.replace(/^eq\./, '');
      const notIn = /^not\.in\.\((.*)\)$/.exec(
        url.searchParams.get('event_name') || '',
      );
      const excluded = new Set(notIn ? notIn[1].split(',') : []);
      const or = url.searchParams.get('or') || '';
      const at = /created_at\.gt\."([^"]+)"/.exec(or)?.[1];
      const afterId = /id\.gt\."([^"]+)"/.exec(or)?.[1];
      const limit = Number(url.searchParams.get('limit') || 1000);
      const page = store
        .filter((r) => r.status === status && r.delivery_lane === lane)
        .filter((r) => !excluded.has(r.event_name))
        .filter(
          (r) =>
            !at ||
            r.created_at > at ||
            (r.created_at === at && afterId !== undefined && r.id > afterId),
        )
        .sort((a, b) =>
          a.created_at === b.created_at
            ? a.id.localeCompare(b.id)
            : a.created_at.localeCompare(b.created_at),
        )
        .slice(0, limit);
      return json(page);
    },
  );
  return { fetchMock, getUrls };
}

function makeService(
  env: Record<string, string>,
  enqueue: jest.Mock,
  db: Partial<DatabaseService> = {},
) {
  const config = {
    get: (key: string) =>
      ({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        ...env,
      })[key],
  } as unknown as ConfigService;
  const service = new SupabaseDrainService(
    config,
    {
      tryAcquireLock: () => true,
      releaseLock: () => undefined,
      isConsentRevoked: () => false,
      ...db,
    } as unknown as DatabaseService,
    { enqueue } as unknown as EventsService,
    { mode: 'live' } as MetaCapiService,
  );
  (service as unknown as { enabled: boolean }).enabled = true;
  return service;
}

const okEnqueue = () =>
  jest.fn((dto: { event_id: string; event_name: string }) => ({
    ok: true,
    blocked_by_consent: false,
    outbox_status: 'pending',
    event_id: dto.event_id,
    event_name: dto.event_name,
  }));

describe('SupabaseDrainService — cola sin bloqueo', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('filas retenidas al frente no impiden drenar un Lead posterior', async () => {
    // 25 Purchase sin fechas de corte (se retienen) y luego un Lead normal.
    const store: Row[] = [];
    for (let i = 1; i <= 25; i += 1) store.push(row(i, 'Purchase'));
    store.push(row(26, 'Lead'));
    const { fetchMock } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = okEnqueue();
    const service = makeService(
      {
        META_PURCHASE_DELIVERY_ENABLED: 'true',
        META_PURCHASE_ACTIVATED_AT: '2026-01-01T00:00:00.000Z',
      },
      enqueue,
    );

    await service.tick();
    expect(enqueue).not.toHaveBeenCalled();

    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ event_name: 'Lead' });
    expect(store.find((r) => r.event_name === 'Lead')?.status).toBe(
      'forwarded',
    );
    expect(
      store
        .filter((r) => r.event_name === 'Purchase')
        .every((r) => r.status === 'pending'),
    ).toBe(true);
  });

  it('una fila retenida se reevalúa cuando vence su espera', async () => {
    const store = [row(1, 'Lead')];
    const { fetchMock } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = jest.fn(() => {
      throw new Error('sqlite_busy');
    });
    const service = makeService({}, enqueue);

    await service.tick();
    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store[0].status).toBe('pending');
    expect(store[0].last_error).toBe('sqlite_busy');

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('no pide a Supabase los flujos con entrega apagada', async () => {
    const store = [row(1, 'Schedule'), row(2, 'Lead')];
    const { fetchMock, getUrls } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = okEnqueue();
    await makeService({}, enqueue).tick();

    const outboxGet = getUrls.find((u) =>
      u.pathname.endsWith('/meta_capi_outbox'),
    )!;
    expect(outboxGet.searchParams.get('event_name')).toBe(
      'not.in.(Schedule,LeadSubmitted,QualifiedLead,Purchase)',
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store[0].status).toBe('pending');
    expect(store[1].status).toBe('forwarded');
  });

  it('BM sin identificadores pasa a needs_review y no se encola', async () => {
    const store = [
      row(1, 'LeadSubmitted', {
        lead_id: uuid(900),
        payload: {
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          contact_id: 'contact-1',
        },
      }),
    ];
    const { fetchMock } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = okEnqueue();
    await makeService(
      { META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED: 'true' },
      enqueue,
    ).tick();

    expect(enqueue).not.toHaveBeenCalled();
    expect(store[0].status).toBe('needs_review');
    expect(store[0].last_error).toBe('bm_identifiers_missing');
  });

  it('payload que viola el contrato del DTO pasa a needs_review', async () => {
    const store = [row(1, 'Lead', { event_id: 'no-es-uuid' })];
    const { fetchMock } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = okEnqueue();
    await makeService({}, enqueue).tick();

    expect(enqueue).not.toHaveBeenCalled();
    expect(store[0].status).toBe('needs_review');
    expect(store[0].last_error).toBe('drain_payload_invalid:event_id');
  });

  it('si tomar el lock falla, el drain no queda bloqueado', async () => {
    const store = [row(1, 'Lead')];
    const { fetchMock } = fakeSupabase(store);
    global.fetch = fetchMock as typeof fetch;
    const enqueue = okEnqueue();
    let calls = 0;
    const service = makeService({}, enqueue, {
      tryAcquireLock: () => {
        calls += 1;
        if (calls === 1) throw new Error('SQLITE_BUSY');
        return true;
      },
    });

    await service.tick();
    expect(service.status.ticking).toBe(false);
    expect(service.status.last_tick_error).toBe('SQLITE_BUSY');
    await service.tick();
    expect(store[0].status).toBe('forwarded');
  });
});

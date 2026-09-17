/**
 * Recorrido Schedule website hasta HTTP Graph interceptado (sin Meta real).
 * META salidas bloqueadas vía mock de fetch; distingue local vs recepción real.
 */
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from './meta-capi.service';
import { EventsService } from '../events/events.service';
import { DatabaseService } from '../database/database.service';

describe('Schedule website → Graph HTTP interceptado (local)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('build+sendToMeta POSTea Schedule/website al dataset web; body sin BM', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      captured.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ events_received: 1, fbtrace_id: 'LOCAL_MOCK' }),
      } as Response;
    }) as typeof fetch;

    const config = {
      get: (key: string) =>
        ({
          META_MODE: 'test',
          META_DATASET_ID: 'dataset-web-test',
          META_PIXEL_ID: 'dataset-web-test',
          META_API_VERSION: 'v21.0',
          META_CAPI_ACCESS_TOKEN: 'token-test-local',
          META_TEST_EVENT_CODE: 'TEST12345',
          META_CORE_SETUP_CONSERVATIVE: 'true',
          META_HTTP_TIMEOUT_MS: '5000',
        })[key],
    } as unknown as ConfigService;

    const meta = new MetaCapiService(config);
    const built = meta.buildGraphPayload({
      eventName: 'Schedule',
      eventId: '11111111-1111-4111-8111-111111111111',
      eventTime: 1720000000,
      actionSource: 'website',
      match: {
        phone: '593990000001',
        externalId: 'lead-1',
      },
    });

    expect(built.payload).toMatchObject({
      data: [
        expect.objectContaining({
          event_name: 'Schedule',
          action_source: 'website',
          event_id: '11111111-1111-4111-8111-111111111111',
          event_time: 1720000000,
        }),
      ],
      test_event_code: 'TEST12345',
    });
    const ev = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(ev.messaging_channel).toBeUndefined();
    expect((ev.user_data as Record<string, unknown>).ctwa_clid).toBeUndefined();

    const send = await meta.sendToMeta('dataset-web-test', built.payload);
    expect(send.ok).toBe(true);
    expect(send.httpStatus).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      'https://graph.facebook.com/v21.0/dataset-web-test/events',
    );
    expect(captured[0].body.data).toEqual(built.payload.data);
    // Prueba local interceptada — no es recepción real en Events Manager.
  });

  it('enqueue Schedule+BM rechazado antes de cualquier HTTP Graph', () => {
    const meta = new MetaCapiService({
      get: () => undefined,
    } as unknown as ConfigService);
    const db = {
      insertOutbox: jest.fn(),
    } as unknown as DatabaseService;
    const events = new EventsService(db, meta);

    expect(() =>
      events.enqueue({
        event_name: 'Schedule',
        ads_consent: true,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        messaging_dataset_id: 'msg-ds',
        ctwa_clid: 'clid',
        whatsapp_business_account_id: 'waba',
        phone: '5939',
        idempotency_key: 'schedule:x',
      } as never),
    ).toThrow(/business_messaging_schedule_not_supported_by_meta/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('META_MODE=disabled no llama Graph (salida medición bloqueada)', async () => {
    let called = false;
    global.fetch = jest.fn(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    const meta = new MetaCapiService({
      get: (key: string) =>
        ({
          META_MODE: 'disabled',
          META_CAPI_ACCESS_TOKEN: 'x',
        })[key],
    } as unknown as ConfigService);

    const gate = meta.assertSendAllowed();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain('disabled');
    expect(called).toBe(false);
  });
});

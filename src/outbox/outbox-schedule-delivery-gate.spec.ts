/**
 * Worker SQLite: META_SCHEDULE_DELIVERY_ENABLED antes de Graph.
 * Schedule encolado + flag OFF → no HTTP Schedule; Lead sí; fila conservada pending.
 */
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { SqliteOutboxStore } from '../database/sqlite-store';
import Database from 'better-sqlite3';

describe('OutboxService — Schedule delivery gate', () => {
  const originalFetch = global.fetch;
  let db: Database.Database;
  let store: SqliteOutboxStore;
  let database: DatabaseService;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteOutboxStore(db);
    store.migrate();
    database = {
      claimPending: (limit: number, lane: 'test' | 'live', opts?: { excludeSchedule?: boolean }) =>
        store.claimPending(limit, lane, opts),
      getOutboxById: (id: number) => store.getOutboxById(id),
      markSent: (id: number, body: unknown) => store.markSent(id, body),
      markRetry: (
        id: number,
        error: string,
        next: string,
        dead: boolean,
      ) => store.markRetry(id, error, next, dead),
      cancelProcessingIfRevoked: (id: number) =>
        store.cancelProcessingIfRevoked(id),
      releaseProcessingToPending: (id: number, reason: string) =>
        store.releaseProcessingToPending(id, reason),
      purgeOld: () => 0,
      isConsentRevoked: () => false,
    } as unknown as DatabaseService;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
    jest.restoreAllMocks();
  });

  it('Schedule ya encolado + delivery OFF: no Graph Schedule; Lead sí; Schedule sigue pending', async () => {
    const graphUrls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      graphUrls.push(String(input));
      const body = JSON.parse(String(init?.body || '{}')) as {
        data?: Array<{ event_name?: string }>;
      };
      expect(body.data?.[0]?.event_name).not.toBe('Schedule');
      return {
        ok: true,
        status: 200,
        json: async () => ({ events_received: 1, fbtrace_id: 'LOCAL' }),
      } as Response;
    }) as typeof fetch;

    const schedulePayload = {
      data: [
        {
          event_name: 'Schedule',
          event_time: 1,
          event_id: '11111111-1111-4111-8111-111111111111',
          action_source: 'website',
          user_data: {},
        },
      ],
    };
    const leadPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: 1,
          event_id: '22222222-2222-4222-8222-222222222222',
          action_source: 'website',
          user_data: {},
        },
      ],
    };

    store.insertOutbox({
      idempotency_key: 'schedule:already-queued',
      event_id: '11111111-1111-4111-8111-111111111111',
      event_name: 'Schedule',
      event_time: 1,
      payload_redacted: { event_name: 'Schedule' },
      graph_payload: schedulePayload,
      dataset_id: 'dataset-web',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-s',
      ads_consent_required: true,
    });
    store.insertOutbox({
      idempotency_key: 'lead:keep-going',
      event_id: '22222222-2222-4222-8222-222222222222',
      event_name: 'Lead',
      event_time: 1,
      payload_redacted: { event_name: 'Lead' },
      graph_payload: leadPayload,
      dataset_id: 'dataset-web',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-l',
      ads_consent_required: false,
    });

    const meta = new MetaCapiService({
      get: (key: string) =>
        ({
          META_MODE: 'live',
          META_DATASET_ID: 'dataset-web',
          META_API_VERSION: 'v21.0',
          META_CAPI_ACCESS_TOKEN: 'token-test-local',
          META_CORE_SETUP_CONSERVATIVE: 'true',
          META_HTTP_TIMEOUT_MS: '5000',
        })[key],
    } as unknown as ConfigService);

    const service = new OutboxService(database, meta, {
      get: (key: string) =>
        ({
          OUTBOX_BATCH_SIZE: '20',
          OUTBOX_MAX_ATTEMPTS: '8',
          OUTBOX_RETENTION_DAYS: '90',
          // Apagado efectivo
          META_SCHEDULE_DELIVERY_ENABLED: 'false',
        })[key],
    } as unknown as ConfigService);

    await service.tick();

    const scheduleRow = db
      .prepare(`SELECT status FROM outbox_events WHERE event_name = 'Schedule'`)
      .get() as { status: string };
    const leadRow = db
      .prepare(`SELECT status FROM outbox_events WHERE event_name = 'Lead'`)
      .get() as { status: string };

    expect(scheduleRow.status).toBe('pending');
    expect(leadRow.status).toBe('sent');
    expect(graphUrls).toHaveLength(1);
    expect(graphUrls[0]).toContain('/dataset-web/events');
  });
});

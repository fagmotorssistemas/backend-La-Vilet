import Database from 'better-sqlite3';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service';
import { SqliteOutboxStore } from '../database/sqlite-store';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';

describe('OutboxService — eventos de más de 7 días', () => {
  const originalFetch = global.fetch;
  let raw: Database.Database;
  let store: SqliteOutboxStore;

  function setup(env: Record<string, string>) {
    raw = new Database(':memory:');
    store = new SqliteOutboxStore(raw);
    store.migrate();
    const database = {
      claimPending: (...args: Parameters<SqliteOutboxStore['claimPending']>) =>
        store.claimPending(...args),
      getOutboxById: (id: number) => store.getOutboxById(id),
      isConsentRevoked: () => false,
      releaseProcessingToPending: (
        ...args: Parameters<SqliteOutboxStore['releaseProcessingToPending']>
      ) => store.releaseProcessingToPending(...args),
      markRetryAndQueueResult: (
        ...args: Parameters<SqliteOutboxStore['markRetryAndQueueResult']>
      ) => store.markRetryAndQueueResult(...args),
      markSentAndQueueResult: (
        ...args: Parameters<SqliteOutboxStore['markSentAndQueueResult']>
      ) => store.markSentAndQueueResult(...args),
      purgeOld: () => undefined,
    } as unknown as DatabaseService;
    const values: Record<string, string> = {
      META_MODE: 'live',
      META_DATASET_ID: 'dataset-web',
      META_CAPI_ACCESS_TOKEN: 'token-local',
      ...env,
    };
    const config = { get: (key: string) => values[key] } as ConfigService;
    return new OutboxService(database, new MetaCapiService(config), config);
  }

  function insertLead(ageDays: number) {
    const eventTime = Math.floor(Date.now() / 1000) - ageDays * 86400;
    store.insertOutbox({
      idempotency_key: `lead:age-${ageDays}`,
      event_id: '11111111-1111-4111-8111-111111111111',
      event_name: 'Lead',
      event_time: eventTime,
      payload_redacted: {},
      graph_payload: {
        data: [
          {
            event_name: 'Lead',
            event_time: eventTime,
            event_id: '11111111-1111-4111-8111-111111111111',
            action_source: 'website',
            user_data: {},
          },
        ],
      },
      dataset_id: 'dataset-web',
      delivery_lane: 'live',
      ads_consent_required: false,
    });
  }

  function graphOk() {
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1, fbtrace_id: 'trace' }),
    })) as unknown as typeof fetch;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    raw.close();
  });

  it('8 días → dead event_time_too_old sin llamar a Graph', async () => {
    const service = setup({ META_EVENT_MAX_AGE_CHECK_ENABLED: 'true' });
    insertLead(8);
    const fetchMock = graphOk();
    global.fetch = fetchMock;
    await service.tick();

    const row = store.getOutboxById(1)!;
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('event_time_too_old');
    expect(row.delivery_outcome).toBe('meta_rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('6 días → se envía normal', async () => {
    const service = setup({ META_EVENT_MAX_AGE_CHECK_ENABLED: 'true' });
    insertLead(6);
    const fetchMock = graphOk();
    global.fetch = fetchMock;
    await service.tick();

    expect(store.getOutboxById(1)!.status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('con el interruptor apagado no cambia el comportamiento', async () => {
    const service = setup({});
    insertLead(8);
    const fetchMock = graphOk();
    global.fetch = fetchMock;
    await service.tick();

    expect(store.getOutboxById(1)!.status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

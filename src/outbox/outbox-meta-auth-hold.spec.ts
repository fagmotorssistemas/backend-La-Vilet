import Database from 'better-sqlite3';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service';
import { SqliteOutboxStore } from '../database/sqlite-store';
import { DatabaseService } from '../database/database.service';
import {
  MetaCapiService,
  isMetaAuthErrorCode,
} from '../meta/meta-capi.service';

describe('OutboxService — error de credencial de Meta', () => {
  const originalFetch = global.fetch;
  let raw: Database.Database;
  let store: SqliteOutboxStore;
  let service: OutboxService;

  beforeEach(() => {
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
    const env: Record<string, string> = {
      META_MODE: 'live',
      META_DATASET_ID: 'dataset-web',
      META_CAPI_ACCESS_TOKEN: 'token-local',
    };
    const config = { get: (key: string) => env[key] } as ConfigService;
    service = new OutboxService(database, new MetaCapiService(config), config);

    store.insertOutbox({
      idempotency_key: 'lead:auth',
      event_id: '11111111-1111-4111-8111-111111111111',
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      payload_redacted: {},
      graph_payload: {
        data: [
          {
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    raw.close();
  });

  function graphError(status: number, code: number) {
    return jest.fn(async () => ({
      ok: false,
      status,
      json: async () => ({
        error: { code, type: 'OAuthException', message: 'token' },
      }),
    })) as unknown as typeof fetch;
  }

  it('token caducado (190) retiene el evento en vez de descartarlo', async () => {
    global.fetch = graphError(400, 190);
    await service.tick();

    const row = store.getOutboxById(1)!;
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('meta_auth_error:190');
    expect(row.attempt_count).toBe(0);
    const waitMs = Date.parse(row.next_attempt_at!) - Date.now();
    expect(waitMs).toBeGreaterThan(590_000);
    expect(waitMs).toBeLessThanOrEqual(600_000);
  });

  it('error de contenido (100) sigue marcándose dead', async () => {
    global.fetch = graphError(400, 100);
    await service.tick();
    expect(store.getOutboxById(1)!.status).toBe('dead');
  });

  it('clasifica códigos de credencial y permisos', () => {
    expect([190, 102, 10, 200, 230, 299].every(isMetaAuthErrorCode)).toBe(true);
    expect([1, 2, 4, 17, 100, 300, 2804003].some(isMetaAuthErrorCode)).toBe(
      false,
    );
  });
});

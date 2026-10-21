import Database from 'better-sqlite3';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service';
import { SqliteOutboxStore } from '../database/sqlite-store';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';

describe('OutboxService — sincronización de resultados con Supabase', () => {
  const originalFetch = global.fetch;
  let raw: Database.Database;
  let store: SqliteOutboxStore;
  let service: OutboxService;

  beforeEach(() => {
    raw = new Database(':memory:');
    store = new SqliteOutboxStore(raw);
    store.migrate();
    const database = {
      claimMetaResultSync: (limit?: number) => store.claimMetaResultSync(limit),
      markMetaResultSynced: (id: number) => store.markMetaResultSynced(id),
      markMetaResultSyncRetry: (id: number, error: string, next: string) =>
        store.markMetaResultSyncRetry(id, error, next),
      markMetaResultSyncDead: (id: number, error: string) =>
        store.markMetaResultSyncDead(id, error),
    } as unknown as DatabaseService;
    const env: Record<string, string> = {
      META_MODE: 'disabled',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    };
    const config = { get: (key: string) => env[key] } as ConfigService;
    service = new OutboxService(database, new MetaCapiService(config), config);

    const event = store.insertOutbox({
      idempotency_key: 'lead:sync',
      event_id: '11111111-1111-4111-8111-111111111111',
      event_name: 'Lead',
      event_time: 1_790_000_000,
      payload_redacted: {},
      graph_payload: { data: [] },
      dataset_id: 'web',
      delivery_lane: 'live',
    }).row;
    store.claimPending(1, 'live');
    store.markRetryAndQueueResult(
      event.id,
      'fetch failed',
      new Date().toISOString(),
      false,
      'transport_failed',
      { network_error: true },
      { p_stage: 'transport_failed', p_event_name: 'Lead' },
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    raw.close();
  });

  function syncRow() {
    return raw
      .prepare(
        `SELECT status, attempt_count, last_error FROM meta_result_sync_outbox`,
      )
      .get() as { status: string; attempt_count: number; last_error: string };
  }

  it('400 de Supabase (p. ej. CHECK de etapa) pasa a dead y no se reintenta', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
    })) as unknown as typeof fetch;
    await service.tick();
    expect(syncRow()).toMatchObject({
      status: 'dead',
      last_error: 'result_sync_http_400',
    });
    await service.tick();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('503 de Supabase queda pending con reintento programado', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch;
    await service.tick();
    expect(syncRow()).toMatchObject({
      status: 'pending',
      last_error: 'result_sync_http_503',
    });
  });

  it('respuesta correcta marca la fila como sincronizada', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
    })) as unknown as typeof fetch;
    await service.tick();
    expect(syncRow().status).toBe('sent');
  });
});

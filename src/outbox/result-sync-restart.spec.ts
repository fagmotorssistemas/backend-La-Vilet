import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { OutboxService } from './outbox.service';

describe('recuperación durable de resultado tras reinicio', () => {
  const originalFetch = global.fetch;
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lavilet-result-restart-'));
    dbPath = join(dir, 'outbox.sqlite');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function config() {
    const env: Record<string, string> = {
      DATABASE_PATH: dbPath,
      META_MODE: 'test',
      META_TEST_EVENT_CODE: 'LOCAL_ONLY',
      META_CAPI_ACCESS_TOKEN: 'local-placeholder',
      META_DATASET_ID: 'web-test',
      META_SCHEDULE_DELIVERY_ENABLED: 'false',
      META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED: 'false',
      META_PURCHASE_DELIVERY_ENABLED: 'false',
      OUTBOX_BATCH_SIZE: '20',
      OUTBOX_MAX_ATTEMPTS: '8',
      OUTBOX_RETENTION_DAYS: '90',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'local-placeholder',
    };
    return { get: (key: string) => env[key] } as unknown as ConfigService;
  }

  function open() {
    const cfg = config();
    const db = new DatabaseService(cfg);
    db.onModuleInit();
    const meta = new MetaCapiService(cfg);
    const worker = new OutboxService(db, meta, cfg);
    return { db, worker };
  }

  it('tras Meta aceptado reintenta solo Supabase y no vuelve a Graph', async () => {
    let graphCalls = 0;
    let syncCalls = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://graph.facebook.com/')) {
        graphCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events_received: 1,
            fbtrace_id: 'LOCAL_GRAPH_ACCEPTED',
          }),
        } as Response;
      }
      if (url.startsWith('https://supabase.invalid/')) {
        syncCalls += 1;
        return {
          ok: syncCalls > 1,
          status: syncCalls > 1 ? 201 : 503,
        } as Response;
      }
      throw new Error(`unexpected_external_url:${url}`);
    }) as typeof fetch;

    const first = open();
    const inserted = first.db.insertOutbox({
      idempotency_key: 'lead:restart-proof',
      event_id: 'b0000000-0000-4000-8000-000000000001',
      event_name: 'Lead',
      event_time: 1790254000,
      payload_redacted: {},
      graph_payload: {
        data: [
          {
            event_name: 'Lead',
            event_id: 'b0000000-0000-4000-8000-000000000001',
            event_time: 1790254000,
            action_source: 'website',
          },
        ],
      },
      dataset_id: 'web-test',
      delivery_lane: 'test',
    }).row;

    await first.worker.tick();
    expect(first.db.getOutboxById(inserted.id)?.status).toBe('sent');
    expect(first.db.getOutboxById(inserted.id)?.delivery_outcome).toBe(
      'meta_accepted',
    );
    expect(first.db.countsMetaResultSync()).toEqual({ pending: 1 });
    expect(graphCalls).toBe(1);
    expect(syncCalls).toBe(1);
    first.db.onModuleDestroy();

    // Simula el paso del backoff mientras el proceso permanece apagado.
    const raw = new Database(dbPath);
    raw
      .prepare(
        `UPDATE meta_result_sync_outbox
         SET next_attempt_at = '2000-01-01T00:00:00.000Z'
         WHERE status = 'pending'`,
      )
      .run();
    raw.close();

    const restarted = open();
    await restarted.worker.tick();
    expect(restarted.db.getOutboxById(inserted.id)?.status).toBe('sent');
    expect(restarted.db.countsMetaResultSync()).toEqual({ sent: 1 });
    expect(graphCalls).toBe(1);
    expect(syncCalls).toBe(2);
    restarted.db.onModuleDestroy();
  });
});

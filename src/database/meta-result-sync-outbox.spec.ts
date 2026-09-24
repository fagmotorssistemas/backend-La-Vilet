import Database from 'better-sqlite3';
import { SqliteOutboxStore } from './sqlite-store';
import { deterministicResultSyncId } from '../outbox/outbox.service';

describe('meta result sync outbox', () => {
  let raw: Database.Database;
  let store: SqliteOutboxStore;

  beforeEach(() => {
    raw = new Database(':memory:');
    store = new SqliteOutboxStore(raw);
    store.migrate();
  });

  afterEach(() => raw.close());

  function insertEvent() {
    return store.insertOutbox({
      idempotency_key: 'lead:one',
      event_id: '11111111-1111-4111-8111-111111111111',
      event_name: 'Lead',
      event_time: 1_700_000_000,
      payload_redacted: {},
      graph_payload: { data: [{ event_name: 'Lead' }] },
      dataset_id: 'web',
      delivery_lane: 'live',
      lead_id: '22222222-2222-4222-8222-222222222222',
    }).row;
  }

  it('confirma Meta y encola su sincronización en una transacción', () => {
    const inserted = insertEvent();
    const claimed = store.claimPending(1, 'live')[0];
    expect(claimed.id).toBe(inserted.id);
    expect(
      store.markSentAndQueueResult(
        claimed.id,
        { http_status: 200, events_received: 1 },
        {
          p_stage: 'meta_accepted',
          p_event_id: claimed.event_id,
        },
      ),
    ).toBe(true);
    expect(store.getOutboxById(claimed.id)?.status).toBe('sent');
    expect(store.getOutboxById(claimed.id)?.delivery_outcome).toBe(
      'meta_accepted',
    );
    expect(store.claimMetaResultSync(10)).toHaveLength(1);
    expect(store.claimPending(10, 'live')).toHaveLength(0);
  });

  it('reintenta sync sin reabrir el evento para envío Graph', () => {
    const row = insertEvent();
    store.claimPending(1, 'live');
    store.markSentAndQueueResult(
      row.id,
      { http_status: 200, events_received: 1 },
      {
        p_stage: 'meta_accepted',
      },
    );
    const sync = store.claimMetaResultSync(1)[0];
    store.markMetaResultSyncRetry(
      sync.id,
      'result_sync_http_503',
      '2000-01-01T00:00:00.000Z',
    );
    expect(store.claimMetaResultSync(1)[0].attempt_count).toBe(2);
    expect(store.getOutboxById(row.id)?.status).toBe('sent');
    expect(store.claimPending(10, 'live')).toHaveLength(0);
  });

  it('usa una identidad estable por evento y etapa', () => {
    const one = deterministicResultSyncId('event-1', 'meta_accepted');
    expect(deterministicResultSyncId('event-1', 'meta_accepted')).toBe(one);
    expect(deterministicResultSyncId('event-1', 'meta_rejected')).not.toBe(one);
    expect(one).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

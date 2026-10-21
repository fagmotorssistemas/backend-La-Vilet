import Database from 'better-sqlite3';
import { SqliteOutboxStore } from './sqlite-store';

/** Algoritmo anterior (en JS), usado como referencia de equivalencia. */
function legacyBreakdown(rows: Array<Record<string, unknown>>, nowMs: number) {
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  const groups = new Map<string, Record<string, unknown>>();
  const add = (row: Record<string, unknown>, window: 'all' | 'last_7d') => {
    let channel = 'unknown';
    try {
      const graph = JSON.parse(String(row.graph_payload)) as {
        data?: Array<Record<string, unknown>>;
      };
      const first = graph.data?.[0];
      const raw = first?.messaging_channel ?? first?.action_source;
      channel = typeof raw === 'string' ? raw : 'unknown';
    } catch {
      /* unknown */
    }
    const item = {
      event_name: String(row.event_name),
      channel,
      dataset_id: String(row.dataset_id),
      delivery_lane: String(row.delivery_lane),
      status: String(row.status),
      delivery_outcome: String(row.delivery_outcome),
      window,
      count: 0,
    };
    const key = JSON.stringify(item);
    const found = groups.get(key);
    if (found) (found.count as number) += 1;
    else groups.set(key, { ...item, count: 1 });
  };
  for (const row of rows) {
    add(row, 'all');
    const at = Number(row.event_time) * 1000;
    if (Number.isFinite(at) && at >= cutoff && at <= nowMs) add(row, 'last_7d');
  }
  return [...groups.values()];
}

const sortKey = (r: Record<string, unknown>) => JSON.stringify(r);

describe('deliveryBreakdown en SQL', () => {
  it('equivale al cálculo anterior en casos borde', () => {
    const db = new Database(':memory:');
    const store = new SqliteOutboxStore(db);
    store.migrate();
    const now = Math.floor(Date.now() / 1000);
    const payloads: unknown[] = [
      { data: [{ action_source: 'website' }] },
      {
        data: [
          {
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
          },
        ],
      },
      { data: [{ action_source: 'website', messaging_channel: null }] },
      { data: [{ action_source: 'website', messaging_channel: 7 }] },
      { data: [{ action_source: 3 }] },
      { data: [] },
      {},
    ];
    let i = 0;
    for (const payload of payloads) {
      for (const eventTime of [now - 60, now - 30 * 24 * 3600, now + 3600]) {
        i += 1;
        store.insertOutbox({
          idempotency_key: `k${i}`,
          event_id: `e${i}`,
          event_name: i % 2 ? 'Lead' : 'ViewContent',
          event_time: eventTime,
          payload_redacted: {},
          graph_payload: payload,
          dataset_id: 'web',
          delivery_lane: 'live',
        });
      }
    }
    // JSON inválido persistido por error.
    db.prepare(
      `UPDATE outbox_events SET graph_payload = '{no-json' WHERE id = 1`,
    ).run();
    db.prepare(
      `UPDATE outbox_events SET status = 'sent' WHERE id % 3 = 0`,
    ).run();

    const raw = db
      .prepare(
        `SELECT event_name, dataset_id, delivery_lane, status, delivery_outcome, graph_payload, event_time FROM outbox_events`,
      )
      .all() as Array<Record<string, unknown>>;
    const nowMs = Date.now();
    const expected = legacyBreakdown(raw, nowMs).map(sortKey).sort();
    const actual = store.deliveryBreakdown().map(sortKey).sort();
    expect(actual).toEqual(expected);
    db.close();
  });
});

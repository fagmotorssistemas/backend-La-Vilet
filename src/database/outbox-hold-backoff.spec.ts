import Database from 'better-sqlite3';
import { SqliteOutboxStore, holdBackoffSeconds } from './sqlite-store';

describe('outbox hold backoff (sin bloqueo de cola)', () => {
  let db: Database.Database;
  let store: SqliteOutboxStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteOutboxStore(db);
    store.migrate();
  });

  afterEach(() => db.close());

  function insert(i: number, eventName: string) {
    store.insertOutbox({
      idempotency_key: `k${i}`,
      event_id: `e${i}`,
      event_name: eventName,
      event_time: 1_760_000_000,
      payload_redacted: {},
      graph_payload: { data: [] },
      dataset_id: 'd',
      delivery_lane: 'live',
    });
  }

  it('20 filas retenidas no impiden reclamar un evento nuevo', () => {
    for (let i = 0; i < 20; i += 1) insert(i, 'Purchase');
    insert(99, 'Lead');

    const first = store.claimPending(20, 'live');
    expect(first).toHaveLength(20);
    for (const row of first) {
      expect(store.releaseProcessingToPending(row.id, 'gate_hold')).toBe(true);
    }

    const second = store.claimPending(20, 'live');
    expect(second.map((row) => row.event_name)).toEqual(['Lead']);
  });

  it('la fila retenida conserva attempt_count y vuelve cuando vence la espera', () => {
    insert(1, 'Purchase');
    const [row] = store.claimPending(1, 'live');
    expect(store.releaseProcessingToPending(row.id, 'gate_hold')).toBe(true);

    const held = store.getOutboxById(row.id)!;
    expect(held.status).toBe('pending');
    expect(held.attempt_count).toBe(0);
    expect(held.hold_count).toBe(1);
    expect(held.last_error).toBe('gate_hold');
    const waitMs = Date.parse(held.next_attempt_at!) - Date.now();
    expect(waitMs).toBeGreaterThan(25_000);
    expect(waitMs).toBeLessThanOrEqual(30_000);

    db.prepare(
      `UPDATE outbox_events SET next_attempt_at = '2000-01-01T00:00:00.000Z'`,
    ).run();
    expect(store.claimPending(1, 'live').map((r) => r.id)).toEqual([row.id]);
  });

  it('retryAfterSec explícito reemplaza la espera creciente', () => {
    insert(1, 'Lead');
    const [row] = store.claimPending(1, 'live');
    store.releaseProcessingToPending(row.id, 'auth', { retryAfterSec: 600 });
    const waitMs =
      Date.parse(store.getOutboxById(row.id)!.next_attempt_at!) - Date.now();
    expect(waitMs).toBeGreaterThan(595_000);
    expect(waitMs).toBeLessThanOrEqual(600_000);
  });

  it('no libera filas que no están en processing', () => {
    insert(1, 'Lead');
    const row = store.getOutboxById(1)!;
    expect(store.releaseProcessingToPending(row.id, 'gate_hold')).toBe(false);
    expect(store.getOutboxById(row.id)!.hold_count).toBe(0);
  });

  it('espera creciente con tope de 1 hora', () => {
    expect([0, 1, 2, 3, 7, 8, 50].map(holdBackoffSeconds)).toEqual([
      30, 60, 120, 240, 3600, 3600, 3600,
    ]);
    expect(holdBackoffSeconds(-5)).toBe(30);
    expect(holdBackoffSeconds(Number.NaN)).toBe(30);
  });
});

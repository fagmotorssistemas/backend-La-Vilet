/**
 * LeadSubmitted ya encolado + delivery OFF → no claim Graph; Lead sí; fila pending.
 */
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../database/sqlite-store';

describe('claimPending — LeadSubmitted delivery gate', () => {
  let db: Database.Database;
  let store: SqliteOutboxStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteOutboxStore(db);
    store.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it('excludeLeadSubmitted conserva LeadSubmitted pending y deja pasar Lead', () => {
    store.insertOutbox({
      idempotency_key: 'lead:web',
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event_name: 'Lead',
      event_time: 1,
      payload_redacted: { event_name: 'Lead' },
      graph_payload: { data: [{ event_name: 'Lead' }] },
      dataset_id: 'WEB_DS',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    });
    store.insertOutbox({
      idempotency_key: 'wa_lead_submitted:lead-1',
      event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      event_name: 'LeadSubmitted',
      event_time: 1,
      payload_redacted: { event_name: 'LeadSubmitted' },
      graph_payload: { data: [{ event_name: 'LeadSubmitted' }] },
      dataset_id: 'MSG_DS',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    });

    const claimed = store.claimPending(10, 'live', {
      excludeLeadSubmitted: true,
    });
    expect(claimed.map((r) => r.event_name)).toEqual(['Lead']);

    const still = db
      .prepare(
        `SELECT status, event_name FROM outbox_events WHERE idempotency_key = ?`,
      )
      .get('wa_lead_submitted:lead-1') as {
      status: string;
      event_name: string;
    };
    expect(still.event_name).toBe('LeadSubmitted');
    expect(still.status).toBe('pending');
  });
});

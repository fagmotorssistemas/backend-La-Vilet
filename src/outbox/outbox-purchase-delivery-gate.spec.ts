/**
 * Entrega OFF de Purchase (contacto calificado) y VentaCerrada (venta real):
 * claim no las toma y quedan pending; Lead sigue.
 */
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../database/sqlite-store';

describe('claimPending — exclusión por evento con entrega apagada', () => {
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

  it('excludeEventNames conserva Purchase y VentaCerrada pending y deja pasar Lead', () => {
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
      idempotency_key: 'purchase:sale-1',
      event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      event_name: 'Purchase',
      event_time: 1,
      payload_redacted: { event_name: 'Purchase' },
      graph_payload: {
        data: [
          {
            event_name: 'Purchase',
            custom_data: { value: 1, currency: 'USD' },
          },
        ],
      },
      dataset_id: 'WEB_DS',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    });

    store.insertOutbox({
      idempotency_key: 'venta_cerrada:sale-1',
      event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      event_name: 'VentaCerrada',
      event_time: 1,
      payload_redacted: { event_name: 'VentaCerrada' },
      graph_payload: { data: [{ event_name: 'VentaCerrada' }] },
      dataset_id: 'WEB_DS',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    });

    const claimed = store.claimPending(10, 'live', {
      excludeEventNames: ['Purchase', 'VentaCerrada'],
    });
    expect(claimed.map((r) => r.event_name)).toEqual(['Lead']);

    const still = db
      .prepare(
        `SELECT status, event_name FROM outbox_events WHERE idempotency_key = ?`,
      )
      .get('purchase:sale-1') as {
      status: string;
      event_name: string;
    };
    expect(still.event_name).toBe('Purchase');
    expect(still.status).toBe('pending');
    // Al encender la entrega, ambas se reclaman.
    expect(
      store
        .claimPending(10, 'live', { excludeEventNames: [] })
        .map((r) => r.event_name),
    ).toEqual(['Purchase', 'VentaCerrada']);
  });
});

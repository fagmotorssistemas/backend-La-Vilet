/**
 * cancelPurchaseBySaleId / annotate after Meta accept.
 */
import Database from 'better-sqlite3'
import { SqliteOutboxStore } from '../database/sqlite-store'

describe('purchase annulment persistence', () => {
  let db: Database.Database
  let store: SqliteOutboxStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new SqliteOutboxStore(db)
    store.migrate()
  })

  afterEach(() => {
    db.close()
  })

  it('cancela pending y anota sent sin revertir', () => {
    store.insertOutbox({
      idempotency_key: 'purchase:sale-open',
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event_name: 'Purchase',
      event_time: 1,
      payload_redacted: { sale_id: 'sale-open' },
      graph_payload: { data: [{ event_name: 'Purchase' }] },
      dataset_id: 'WEB',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    })
    const sent = store.insertOutbox({
      idempotency_key: 'purchase:sale-sent',
      event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      event_name: 'Purchase',
      event_time: 1,
      payload_redacted: { sale_id: 'sale-sent' },
      graph_payload: { data: [{ event_name: 'Purchase' }] },
      dataset_id: 'WEB',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    })
    const claimed = store.claimPending(10, 'live', { excludePurchase: false })
    const processing = claimed.find((r) => r.event_id === sent.row.event_id)
    expect(processing).toBeTruthy()
    store.markSent(processing!.id, {
      http_status: 200,
      events_received: 1,
      fbtrace_id: 'trace',
    })

    expect(store.cancelPurchaseBySaleId('sale-open', 'contract_anulado')).toBe(1)
    expect(
      store.annotatePurchaseAnnulledAfterAccept(
        'sale-sent',
        'annulled_after_meta_accepted',
      ),
    ).toBe(1)

    const open = db
      .prepare(`SELECT status, last_error FROM outbox_events WHERE idempotency_key=?`)
      .get('purchase:sale-open') as { status: string; last_error: string }
    const accepted = db
      .prepare(`SELECT status, last_error FROM outbox_events WHERE idempotency_key=?`)
      .get('purchase:sale-sent') as { status: string; last_error: string }

    expect(open.status).toBe('cancelled')
    expect(open.last_error).toBe('contract_anulado')
    expect(accepted.status).toBe('sent')
    expect(accepted.last_error).toBe('annulled_after_meta_accepted')
  })
})

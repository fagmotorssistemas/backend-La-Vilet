import Database from 'better-sqlite3';
import { SqliteOutboxStore } from '../database/sqlite-store';

describe('claimPending — QualifiedLead delivery gate', () => {
  it('permanece pending mientras su flag independiente está apagado', () => {
    const sqlite = new Database(':memory:');
    const store = new SqliteOutboxStore(sqlite);
    store.migrate();
    const eventId = '11111111-1111-4111-8111-111111111111';
    store.insertOutbox({
      idempotency_key: 'wa_crm_qualified:lead-1',
      event_id: eventId,
      event_name: 'QualifiedLead',
      event_time: 1700000000,
      payload_redacted: { temperature: 'tibio' },
      graph_payload: {
        data: [
          {
            event_name: 'QualifiedLead',
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
          },
        ],
      },
      dataset_id: 'messaging-dataset',
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-1',
      ads_consent_required: true,
    });
    expect(
      store.claimPending(10, 'live', { excludeQualifiedLead: true }),
    ).toHaveLength(0);
    expect(store.getLatestByEventId(eventId)?.status).toBe('pending');
    expect(store.deliveryBreakdown()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: 'QualifiedLead',
          channel: 'whatsapp',
          dataset_id: 'messaging-dataset',
          delivery_lane: 'live',
          status: 'pending',
          delivery_outcome: 'backend_accepted',
          window: 'all',
          count: 1,
        }),
      ]),
    );
    expect(
      store.claimPending(10, 'live', { excludeQualifiedLead: false }),
    ).toHaveLength(1);
    sqlite.close();
  });
});

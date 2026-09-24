import { ConflictException } from '@nestjs/common';
import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';

describe('events idempotency and delivery outcomes', () => {
  const eventId = '11111111-1111-4111-8111-111111111111';

  it('rechaza reutilizar una clave en otro carril', () => {
    const db = {
      insertOutbox: () => ({
        inserted: false,
        row: {
          event_id: eventId,
          event_name: 'Lead',
          event_time: 1_700_000_000,
          status: 'pending',
          delivery_lane: 'test',
          dataset_id: 'web',
          delivery_outcome: 'backend_accepted',
        },
      }),
    } as unknown as DatabaseService;
    const meta = {
      mode: 'live',
      datasetId: 'web',
      buildFbc: () => null,
      buildGraphPayload: () => ({
        eventId,
        eventTime: 1_700_000_000,
        payload: {},
        redacted: {},
      }),
      assertSendAllowed: () => ({ ok: true }),
    } as unknown as MetaCapiService;
    const service = new EventsService(db, meta);
    expect(() =>
      service.enqueue({
        event_name: 'Lead',
        idempotency_key: 'lead:one',
        event_id: eventId,
        event_time: 1_700_000_000,
        action_source: 'website',
        delivery_lane: 'live',
        ads_consent: true,
      } as EnqueueEventDto),
    ).toThrow(ConflictException);
  });

  it('no presenta un fallo de transporte como rechazo Meta', () => {
    const db = {
      getLatestByEventId: () => ({
        event_id: eventId,
        event_name: 'Lead',
        status: 'failed',
        attempt_count: 1,
        last_error: 'fetch failed',
        delivery_lane: 'live',
        dataset_id: 'web',
        sent_at: null,
        updated_at: '2026-09-24T00:00:00Z',
        created_at: '2026-09-24T00:00:00Z',
        meta_response_redacted: JSON.stringify({ network_error: true }),
        delivery_outcome: 'transport_failed',
      }),
    } as unknown as DatabaseService;
    const result = new EventsService(db, {} as MetaCapiService).lookupByEventId(
      eventId,
    );
    expect(result.delivery_outcome).toBe('transport_failed');
    expect(result.acceptance_tier).toBe('insufficient_evidence');
    expect(result.api_accepted).toBe(false);
  });
});

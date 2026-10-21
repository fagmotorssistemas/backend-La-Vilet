import { BadRequestException } from '@nestjs/common';
import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';

describe('enqueue delivery lane', () => {
  function setup(mode: 'live' | 'test' | 'disabled') {
    const insertOutbox = jest.fn((row) => ({
      inserted: true,
      row: { ...row, status: 'pending' },
    }));
    const meta = {
      mode,
      datasetId: 'web',
      buildFbc: () => null,
      buildGraphPayload: () => ({
        eventId: 'event-1',
        eventTime: 1,
        payload: {},
        redacted: {},
      }),
      assertSendAllowedFor: () =>
        mode === 'disabled' ? { ok: false, reason: 'disabled' } : { ok: true },
    };
    return {
      insertOutbox,
      service: new EventsService(
        { insertOutbox } as unknown as DatabaseService,
        meta as unknown as MetaCapiService,
      ),
    };
  }

  it.each([
    ['live', 'test'],
    ['test', 'live'],
  ] as const)('rejects %s mode with %s lane before inserting', (mode, lane) => {
    const { service, insertOutbox } = setup(mode);
    try {
      service.enqueue({
        event_name: 'Lead',
        idempotency_key: 'lead:1',
        action_source: 'website',
        ads_consent: true,
        delivery_lane: lane,
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      expect((error as Error).message).toBe('delivery_lane_mismatch');
    }
    expect(insertOutbox).not.toHaveBeenCalled();
  });

  it.each(['test', 'live'] as const)(
    'disabled still inserts %s lane',
    (lane) => {
      const { service, insertOutbox } = setup('disabled');
      const result = service.enqueue({
        event_name: 'Lead',
        idempotency_key: 'lead:1',
        action_source: 'website',
        ads_consent: true,
        delivery_lane: lane,
      });
      expect(insertOutbox).toHaveBeenCalledTimes(1);
      expect(result.accepted).toBe(true);
      expect(result.delivery_lane).toBe(lane);
      expect(result.delivery).toBe('held:disabled');
    },
  );
});

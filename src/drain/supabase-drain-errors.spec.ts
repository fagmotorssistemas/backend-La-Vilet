import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

describe('drain contract errors and lane isolation', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    [
      new ConflictException('idempotency_key_conflict'),
      'needs_review',
      'nest_idempotency_conflict',
      1,
    ],
    [
      new BadRequestException('delivery_lane_mismatch'),
      'needs_review',
      'delivery_lane_mismatch',
      1,
    ],
    [new Error('fetch failed'), 'pending', 'fetch failed', 2],
  ])(
    'handles %s without touching test rows',
    async (error, status, reason, attempts) => {
      const makeRow = (lane: string) => ({
        id: `row-${lane}`,
        idempotency_key: `lead:${lane}`,
        event_id: `event-${lane}`,
        event_name: 'Lead',
        event_time: 1,
        payload: { action_source: 'website' },
        status: 'pending',
        delivery_lane: lane,
        lead_id: null,
        visitor_key: null,
        ads_consent_required: false,
        last_error: null as string | null,
      });
      const store = [makeRow('live'), makeRow('test')];
      const testSnapshot = { ...store[1] };
      const batches: string[][] = [];
      const patches: string[] = [];
      global.fetch = jest.fn(async (input, init) => {
        const url = new URL(String(input));
        let body: unknown = [];
        if (url.pathname === '/rest/v1/meta_capi_outbox') {
          if (init?.method === 'PATCH') {
            const row = store.find(
              (r) => `eq.${r.id}` === url.searchParams.get('id'),
            )!;
            patches.push(row.id);
            Object.assign(row, JSON.parse(String(init.body)));
            body = [row];
          } else {
            expect(url.searchParams.get('delivery_lane')).toBe('eq.live');
            expect(url.searchParams.get('status')).toBe('eq.pending');
            const rows = store.filter(
              (r) =>
                `eq.${r.delivery_lane}` ===
                  url.searchParams.get('delivery_lane') &&
                `eq.${r.status}` === url.searchParams.get('status'),
            );
            batches.push(rows.map((r) => r.id));
            body = rows;
          }
        }
        return { ok: true, status: 200, json: async () => body } as Response;
      }) as typeof fetch;
      const enqueue = jest.fn(() => {
        throw error;
      });
      const service = new SupabaseDrainService(
        {
          get: (key: string) =>
            ({
              SUPABASE_URL: 'https://example.supabase.co',
              SUPABASE_SERVICE_ROLE_KEY: 'test-key',
            })[key],
        } as unknown as ConfigService,
        {
          tryAcquireLock: () => true,
          releaseLock: () => undefined,
          isConsentRevoked: () => false,
        } as unknown as DatabaseService,
        { enqueue } as unknown as EventsService,
        { mode: 'live' } as MetaCapiService,
      );
      (service as unknown as { enabled: boolean }).enabled = true;
      await service.tick();
      expect(store[0].status).toBe(status);
      expect(store[0].last_error).toBe(reason);
      await service.tick();
      expect(enqueue).toHaveBeenCalledTimes(attempts as number);
      expect(batches).toEqual([
        ['row-live'],
        status === 'pending' ? ['row-live'] : [],
      ]);
      expect(patches.every((id) => id === 'row-live')).toBe(true);
      expect(store[1]).toEqual(testSnapshot);
    },
  );
});

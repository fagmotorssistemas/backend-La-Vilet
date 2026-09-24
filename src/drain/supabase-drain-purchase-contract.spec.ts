import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

describe('Supabase drain Purchase contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('conserva registered_at y sale_at originales al pasar a Nest', async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/unit_sales_closings?')) {
        return new Response(
          JSON.stringify([
            {
              id: '11111111-1111-4111-8111-111111111111',
              contract_id: null,
              contract: null,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/meta_capi_outbox?')) {
        return new Response(JSON.stringify([{ id: 'outbox-row' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const service = new SupabaseDrainService(
      {
        get: (key: string) =>
          ({
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'test',
          })[key],
      } as unknown as ConfigService,
      { isConsentRevoked: () => false } as unknown as DatabaseService,
      {
        enqueue: (dto: Record<string, unknown>) => {
          captured.push(dto);
          return {
            ok: true,
            blocked_by_consent: false,
            outbox_status: 'pending',
          };
        },
      } as unknown as EventsService,
      { mode: 'live' } as unknown as MetaCapiService,
    );

    const outcome = await (
      service as unknown as {
        forwardRow(row: Record<string, unknown>): Promise<string>;
      }
    ).forwardRow({
      id: 'outbox-row',
      idempotency_key: 'purchase:11111111-1111-4111-8111-111111111111',
      event_id: '22222222-2222-4222-8222-222222222222',
      event_name: 'Purchase',
      event_time: 1_790_112_000,
      status: 'pending',
      delivery_lane: 'live',
      lead_id: '33333333-3333-4333-8333-333333333333',
      visitor_key: null,
      ads_consent_required: false,
      payload: {
        action_source: 'system_generated',
        sale_id: '11111111-1111-4111-8111-111111111111',
        unit_id: '44444444-4444-4444-8444-444444444444',
        registered_at: '2026-09-23T10:00:00.000Z',
        sale_at: '2026-09-23T09:00:00.000Z',
        value: 100,
        currency: 'USD',
      },
    });

    expect(outcome).toBe('forwarded');
    expect(captured[0].registered_at).toBe('2026-09-23T10:00:00.000Z');
    expect(captured[0].sale_at).toBe('2026-09-23T09:00:00.000Z');
  });
});

import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import type { EnqueueEventDto } from '../events/dto/enqueue-event.dto';

describe('drain — eventos vencidos y nombre/apellido', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function run(
    rowOverrides: Record<string, unknown>,
    meta: Partial<MetaCapiService>,
  ) {
    const row = {
      id: 'row-1',
      idempotency_key: 'lead:drain-age',
      event_id: 'bbbbbbbb-0000-4000-8000-000000000001',
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      payload: { action_source: 'website' } as Record<string, unknown>,
      status: 'pending',
      delivery_lane: 'live',
      lead_id: null,
      visitor_key: null,
      ads_consent_required: false,
      last_error: null as string | null,
      ...rowOverrides,
    };
    const store = [row];
    global.fetch = jest.fn(async (input, init) => {
      const url = new URL(String(input));
      let body: unknown = [];
      if (url.pathname === '/rest/v1/meta_capi_outbox') {
        if (init?.method === 'PATCH') {
          Object.assign(row, JSON.parse(String(init.body)));
          body = [row];
        } else {
          body = store.filter((r) => r.status === 'pending');
        }
      }
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as typeof fetch;
    const enqueued: EnqueueEventDto[] = [];
    const enqueue = jest.fn((dto: EnqueueEventDto) => {
      enqueued.push(dto);
      return {
        ok: true,
        accepted: true,
        duplicate: false,
        blocked_by_consent: false,
        event_id: dto.event_id,
        outbox_status: 'pending',
      };
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
      { mode: 'live', ...meta } as MetaCapiService,
    );
    (service as unknown as { enabled: boolean }).enabled = true;
    return { service, row, enqueue, enqueued };
  }

  it('fila de hace 8 días → needs_review event_time_too_old, no pasa a Nest', async () => {
    const { service, row, enqueue } = run(
      { event_time: Math.floor(Date.now() / 1000) - 8 * 86400 },
      { eventMaxAgeCheckEnabled: true },
    );
    await service.tick();
    expect(row.status).toBe('needs_review');
    expect(row.last_error).toBe('event_time_too_old');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('con el interruptor apagado la fila vieja sigue pasando a Nest', async () => {
    const { service, enqueue } = run(
      { event_time: Math.floor(Date.now() / 1000) - 8 * 86400 },
      {},
    );
    await service.tick();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('copia first_name y last_name del payload', async () => {
    const { service, enqueued } = run(
      {
        payload: {
          action_source: 'website',
          first_name: 'María José',
          last_name: 'Pérez Ortiz',
          full_name: 'María José Pérez Ortiz',
        },
      },
      {},
    );
    await service.tick();
    expect(enqueued[0].first_name).toBe('María José');
    expect(enqueued[0].last_name).toBe('Pérez Ortiz');
  });
});

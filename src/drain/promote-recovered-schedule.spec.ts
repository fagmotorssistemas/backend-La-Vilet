/**
 * Promote recovered: transición atómica review_hold→pending, paginación y carrera.
 */
import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('promoteRecoveredWebScheduleHolds — seguro + avance', () => {
  const originalFetch = global.fetch;
  const leadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function buildService() {
    return new SupabaseDrainService(
      {
        get: (key: string) =>
          ({
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
            SUPABASE_DRAIN_BATCH_SIZE: '20',
            SUPABASE_DRAIN_LOCK_TTL_MS: '60000',
            META_SCHEDULE_RECOVER_ENABLED: 'true',
            META_SCHEDULE_DELIVERY_ENABLED: 'true',
          })[key],
      } as unknown as ConfigService,
      {
        tryAcquireLock: () => true,
        releaseLock: () => undefined,
        isConsentRevoked: () => false,
      } as unknown as DatabaseService,
      {
        enqueue: () => ({
          ok: true,
          blocked_by_consent: false,
          outbox_status: 'pending',
        }),
      } as unknown as EventsService,
      { mode: 'live' } as unknown as MetaCapiService,
    );
  }

  function hold(id: string, apptId: string, extras: Record<string, unknown> = {}) {
    return {
      id,
      lead_id: leadId,
      event_name: 'Schedule',
      status: 'review_hold',
      last_error: 'recovered_pre_intent_gap',
      idempotency_key: `schedule:${apptId}`,
      created_at: '2026-09-17T10:00:00.000Z',
      payload: {
        action_source: 'website',
        channel_kind: 'web',
        appointment_id: apptId,
      },
      ...extras,
    };
  }

  it('PATCH promote solo con status=eq.review_hold; carrera cancelada → 0 filas', async () => {
    const apptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const holdId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    let holdStatus = 'review_hold';

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/rpc/')) return jsonResponse(0);
      if (url.includes('meta_ads_consent_ledger')) return jsonResponse([]);
      if (url.includes('meta_capi_outbox') && method === 'GET' && url.includes('review_hold')) {
        return jsonResponse(holdStatus === 'review_hold' ? [hold(holdId, apptId)] : []);
      }
      if (url.includes('meta_capi_outbox') && method === 'GET' && url.includes('pending')) {
        return jsonResponse([]);
      }
      if (url.includes('/appointments')) {
        return jsonResponse([
          {
            id: apptId,
            lead_id: leadId,
            status: 'aceptado',
            channel: 'web',
            confirmed_by_client: true,
            confirmed_at: new Date().toISOString(),
          },
        ]);
      }
      if (url.includes('/leads')) {
        return jsonResponse([{ meta_ads_consent: true }]);
      }
      if (url.includes('meta_capi_outbox') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        patches.push({ url, body });
        // Simula revocación concurrente: ya no está en review_hold.
        if (url.includes('status=eq.review_hold') && holdStatus !== 'review_hold') {
          return jsonResponse([]);
        }
        if (url.includes('status=eq.review_hold') && body.status === 'pending') {
          // Primera llamada: otro worker canceló justo antes.
          holdStatus = 'cancelled';
          return jsonResponse([]);
        }
        return jsonResponse([{ id: holdId, status: body.status }]);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const service = buildService();
    (service as unknown as { enabled: boolean }).enabled = true;
    await service.tick();

    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect(patches[0].url).toContain('status=eq.review_hold');
    expect(patches.some((p) => p.body.status === 'pending' && p.url.includes(holdId))).toBe(
      true,
    );
    // No hubo representación → no se “forzó” pending sobre cancelled.
    expect(holdStatus).toBe('cancelled');
  });

  it('50 omitidas + 1 válida: cursor avanza y la válida se promueve', async () => {
    const validAppt = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const validId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const skipped = Array.from({ length: 50 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const appt = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return hold(id, appt, {
        payload: {
          action_source: 'website',
          appointment_id: appt,
        },
      });
    });
    const valid = hold(validId, validAppt);
    const pages: string[] = [];
    const promoted: string[] = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/rpc/')) return jsonResponse(0);
      if (url.includes('meta_ads_consent_ledger')) return jsonResponse([]);
      if (url.includes('meta_capi_outbox') && method === 'GET' && url.includes('review_hold')) {
        pages.push(url);
        const u = new URL(url);
        const idFilter = u.searchParams.get('id');
        if (!idFilter) {
          return jsonResponse(skipped);
        }
        // Segunda página tras cursor id=gt.lastSkipped
        expect(idFilter.startsWith('gt.')).toBe(true);
        return jsonResponse([valid]);
      }
      if (url.includes('meta_capi_outbox') && method === 'GET' && url.includes('pending')) {
        return jsonResponse([]);
      }
      if (url.includes('/appointments')) {
        const u = new URL(url);
        const idEq = u.searchParams.get('id') || '';
        const apptId = idEq.replace('eq.', '');
        // Solo la válida tiene confirmación reciente web.
        if (apptId === validAppt) {
          return jsonResponse([
            {
              id: validAppt,
              lead_id: leadId,
              status: 'aceptado',
              channel: 'web',
              confirmed_by_client: true,
              confirmed_at: new Date().toISOString(),
            },
          ]);
        }
        // Omitidas: fuera de lookback
        return jsonResponse([
          {
            id: apptId,
            lead_id: leadId,
            status: 'aceptado',
            channel: 'web',
            confirmed_by_client: true,
            confirmed_at: new Date(
              Date.now() - 40 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        ]);
      }
      if (url.includes('/leads')) {
        return jsonResponse([{ meta_ads_consent: true }]);
      }
      if (url.includes('meta_capi_outbox') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        expect(url).toContain('status=eq.review_hold');
        if (body.status === 'pending') {
          const idMatch = url.match(/id=eq\.([^&]+)/);
          promoted.push(idMatch ? decodeURIComponent(idMatch[1]) : '');
          return jsonResponse([{ id: promoted[promoted.length - 1], status: 'pending' }]);
        }
        return jsonResponse([]);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const service = buildService();
    (service as unknown as { enabled: boolean }).enabled = true;
    await service.tick();

    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(promoted).toContain(validId);
    expect(promoted.every((id) => id === validId)).toBe(true);
  });
});

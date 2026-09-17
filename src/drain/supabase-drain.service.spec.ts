/**
 * Drain Nest de meta_capi_outbox: review_hold excluido; pending se procesa.
 * Dependencias simuladas (fetch Supabase + enqueue). Sin Meta real.
 */
import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

type OutboxRow = {
  id: string;
  idempotency_key: string;
  event_id: string;
  event_name: 'ViewContent' | 'Lead' | 'Schedule';
  event_time: number;
  payload: Record<string, unknown>;
  status: string;
  delivery_lane: 'test' | 'live';
  lead_id: string | null;
  visitor_key: string | null;
  ads_consent_required: boolean;
  created_at?: string;
  last_error?: string | null;
  forwarded_at?: string | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('SupabaseDrainService — review_hold vs pending', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('Schedule review_hold no se envía ni muda; Lead pending sí (enqueue simulado)', async () => {
    const store: OutboxRow[] = [
      {
        id: 'row-schedule-hold',
        idempotency_key: 'schedule:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        event_id: '11111111-1111-4111-8111-111111111111',
        event_name: 'Schedule',
        event_time: 1,
        payload: { action_source: 'website', phone: '593990000000' },
        status: 'review_hold',
        delivery_lane: 'live',
        lead_id: 'lead-1',
        visitor_key: null,
        ads_consent_required: true,
        created_at: '2026-09-17T10:00:00.000Z',
      },
      {
        id: 'row-lead-pending',
        idempotency_key: 'lead:bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        event_id: '22222222-2222-4222-8222-222222222222',
        event_name: 'Lead',
        event_time: 1,
        payload: { action_source: 'website', phone: '593990000001' },
        status: 'pending',
        delivery_lane: 'live',
        lead_id: 'lead-2',
        visitor_key: null,
        ads_consent_required: false,
        created_at: '2026-09-17T10:01:00.000Z',
      },
    ];

    const enqueueCalls: Array<{ event_name: string; event_id: string }> = [];
    const patchBodies: Array<{ id: string; body: Record<string, unknown> }> =
      [];
    const outboxGetUrls: string[] = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/rest/v1/rpc/lv_recover_missing_meta_lead_outbox')) {
        return jsonResponse({ recovered: 0 });
      }

      if (url.includes('/rest/v1/meta_ads_consent_ledger')) {
        return jsonResponse([]);
      }

      if (url.includes('/rest/v1/meta_capi_outbox') && method === 'GET') {
        outboxGetUrls.push(url);
        const u = new URL(url);
        const statusFilter = u.searchParams.get('status');
        const laneFilter = u.searchParams.get('delivery_lane');
        expect(statusFilter).toBe('eq.pending');
        expect(laneFilter).toBe('eq.live');

        const rows = store.filter((r) => {
          if (statusFilter === 'eq.pending' && r.status !== 'pending') return false;
          if (laneFilter === 'eq.live' && r.delivery_lane !== 'live') return false;
          return true;
        });
        return jsonResponse(rows);
      }

      if (url.includes('/rest/v1/meta_capi_outbox') && method === 'PATCH') {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        patchBodies.push({ id, body });
        const row = store.find((r) => r.id === id);
        if (row && typeof body.status === 'string') {
          row.status = body.status;
          row.last_error =
            body.last_error === undefined
              ? row.last_error
              : (body.last_error as string | null);
          if (body.forwarded_at) {
            row.forwarded_at = String(body.forwarded_at);
          }
        }
        return jsonResponse([{ id }]);
      }

      if (url.includes('/rest/v1/leads')) {
        return jsonResponse([{ meta_ads_consent: true }]);
      }

      return jsonResponse({}, 404);
    }) as typeof fetch;

    const config = {
      get: (key: string) => {
        const map: Record<string, string> = {
          SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
          SUPABASE_DRAIN_BATCH_SIZE: '20',
          SUPABASE_DRAIN_LOCK_TTL_MS: '60000',
        };
        return map[key];
      },
    } as unknown as ConfigService;

    const db = {
      tryAcquireLock: () => true,
      releaseLock: () => undefined,
      isConsentRevoked: () => false,
      revokeConsent: () => undefined,
      cancelPendingForScope: () => undefined,
    } as unknown as DatabaseService;

    const events = {
      enqueue: (dto: { event_name: string; event_id: string }) => {
        enqueueCalls.push({
          event_name: dto.event_name,
          event_id: dto.event_id,
        });
        return {
          ok: true,
          blocked_by_consent: false,
          outbox_status: 'pending',
        };
      },
    } as unknown as EventsService;

    const meta = { mode: 'live' } as unknown as MetaCapiService;

    const service = new SupabaseDrainService(config, db, events, meta);
    // Activa un tick sin arrancar el timer de onModuleInit.
    (service as unknown as { enabled: boolean }).enabled = true;

    await service.tick();

    const schedule = store.find((r) => r.id === 'row-schedule-hold')!;
    const lead = store.find((r) => r.id === 'row-lead-pending')!;

    expect(outboxGetUrls.length).toBeGreaterThanOrEqual(1);
    expect(outboxGetUrls[0]).toContain('status=eq.pending');
    expect(outboxGetUrls[0]).not.toContain('review_hold');

    expect(enqueueCalls).toEqual([
      {
        event_name: 'Lead',
        event_id: '22222222-2222-4222-8222-222222222222',
      },
    ]);
    expect(
      enqueueCalls.some((c) => c.event_name === 'Schedule'),
    ).toBe(false);

    expect(schedule.status).toBe('review_hold');
    expect(schedule.forwarded_at).toBeUndefined();
    expect(patchBodies.some((p) => p.id === 'row-schedule-hold')).toBe(false);

    expect(lead.status).toBe('forwarded');
    expect(patchBodies.some((p) => p.id === 'row-lead-pending')).toBe(true);
  });

  it('si el result set incluye review_hold, no encola ni marca esa fila', async () => {
    const hold: OutboxRow = {
      id: 'injected-hold',
      idempotency_key: 'schedule:hold',
      event_id: '33333333-3333-4333-8333-333333333333',
      event_name: 'Schedule',
      event_time: 1,
      payload: { action_source: 'website', phone: '5939' },
      status: 'review_hold',
      delivery_lane: 'live',
      lead_id: null,
      visitor_key: null,
      ads_consent_required: false,
    };
    const pending: OutboxRow = {
      id: 'injected-pending',
      idempotency_key: 'lead:ok',
      event_id: '44444444-4444-4444-8444-444444444444',
      event_name: 'Lead',
      event_time: 1,
      payload: { action_source: 'website', phone: '5939' },
      status: 'pending',
      delivery_lane: 'live',
      lead_id: null,
      visitor_key: null,
      ads_consent_required: false,
    };

    const enqueueNames: string[] = [];
    const patchedIds: string[] = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/rpc/')) return jsonResponse({});
      if (url.includes('meta_ads_consent_ledger')) return jsonResponse([]);
      if (url.includes('meta_capi_outbox') && method === 'GET') {
        // Simula fuga: PostgREST devolviera también review_hold.
        return jsonResponse([hold, pending]);
      }
      if (url.includes('meta_capi_outbox') && method === 'PATCH') {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
        patchedIds.push(id);
        const body = JSON.parse(String(init?.body || '{}')) as {
          status?: string;
        };
        if (id === pending.id && body.status) pending.status = body.status;
        if (id === hold.id && body.status) hold.status = body.status;
        return jsonResponse([{ id }]);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const service = new SupabaseDrainService(
      {
        get: (key: string) =>
          ({
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
            SUPABASE_DRAIN_BATCH_SIZE: '20',
            SUPABASE_DRAIN_LOCK_TTL_MS: '60000',
          })[key],
      } as unknown as ConfigService,
      {
        tryAcquireLock: () => true,
        releaseLock: () => undefined,
        isConsentRevoked: () => false,
      } as unknown as DatabaseService,
      {
        enqueue: (dto: { event_name: string }) => {
          enqueueNames.push(dto.event_name);
          return { ok: true, blocked_by_consent: false, outbox_status: 'pending' };
        },
      } as unknown as EventsService,
      { mode: 'live' } as unknown as MetaCapiService,
    );
    (service as unknown as { enabled: boolean }).enabled = true;

    await service.tick();

    expect(enqueueNames).toEqual(['Lead']);
    expect(hold.status).toBe('review_hold');
    expect(patchedIds).toEqual(['injected-pending']);
    expect(pending.status).toBe('forwarded');
  });

  it('Schedule pending no se drena si META_SCHEDULE_DELIVERY_ENABLED off', async () => {
    const schedulePending: OutboxRow = {
      id: 'sch-pending',
      idempotency_key: 'schedule:x',
      event_id: '55555555-5555-4555-8555-555555555555',
      event_name: 'Schedule',
      event_time: 1,
      payload: { action_source: 'website', phone: '5939' },
      status: 'pending',
      delivery_lane: 'live',
      lead_id: null,
      visitor_key: null,
      ads_consent_required: false,
    };
    const leadPending: OutboxRow = {
      id: 'lead-pending',
      idempotency_key: 'lead:y',
      event_id: '66666666-6666-4666-8666-666666666666',
      event_name: 'Lead',
      event_time: 1,
      payload: { action_source: 'website', phone: '5939' },
      status: 'pending',
      delivery_lane: 'live',
      lead_id: null,
      visitor_key: null,
      ads_consent_required: false,
    };
    const enqueueNames: string[] = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/rpc/')) return jsonResponse({});
      if (url.includes('meta_ads_consent_ledger')) return jsonResponse([]);
      if (url.includes('meta_capi_outbox') && method === 'GET') {
        return jsonResponse([schedulePending, leadPending]);
      }
      if (url.includes('meta_capi_outbox') && method === 'PATCH') {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
        const body = JSON.parse(String(init?.body || '{}')) as { status?: string };
        if (id === leadPending.id && body.status) leadPending.status = body.status;
        if (id === schedulePending.id && body.status) {
          schedulePending.status = body.status;
        }
        return jsonResponse([{ id }]);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const service = new SupabaseDrainService(
      {
        get: (key: string) =>
          ({
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
            SUPABASE_DRAIN_BATCH_SIZE: '20',
            SUPABASE_DRAIN_LOCK_TTL_MS: '60000',
            // delivery off
            META_SCHEDULE_DELIVERY_ENABLED: 'false',
          })[key],
      } as unknown as ConfigService,
      {
        tryAcquireLock: () => true,
        releaseLock: () => undefined,
        isConsentRevoked: () => false,
      } as unknown as DatabaseService,
      {
        enqueue: (dto: { event_name: string }) => {
          enqueueNames.push(dto.event_name);
          return { ok: true, blocked_by_consent: false, outbox_status: 'pending' };
        },
      } as unknown as EventsService,
      { mode: 'live' } as unknown as MetaCapiService,
    );
    (service as unknown as { enabled: boolean }).enabled = true;

    await service.tick();

    expect(enqueueNames).toEqual(['Lead']);
    expect(schedulePending.status).toBe('pending');
  });
});

/**
 * Promote Nest de review_hold recuperados: límites + revalidación
 * (consent, confirmación cliente, canal web, antigüedad) antes de pending/envío.
 * Sin Meta real.
 */
import { ConfigService } from '@nestjs/config';
import { SupabaseDrainService } from './supabase-drain.service';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { MetaCapiService } from '../meta/meta-capi.service';

type FetchCall = { url: string; method: string; body?: string };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('promoteRecoveredWebScheduleHolds — revalidación', () => {
  const originalFetch = global.fetch;
  const apptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const leadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const holdId = 'hold-1';

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function buildService(env: Record<string, string> = {}) {
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
            ...env,
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

  function holdRow(overrides: Record<string, unknown> = {}) {
    return {
      id: holdId,
      lead_id: leadId,
      event_name: 'Schedule',
      status: 'review_hold',
      last_error: 'recovered_pre_intent_gap',
      idempotency_key: `schedule:${apptId}`,
      payload: {
        action_source: 'website',
        channel_kind: 'web',
        appointment_id: apptId,
      },
      ...overrides,
    };
  }

  async function runPromoteTick(opts: {
    hold?: Record<string, unknown>;
    appointment?: Record<string, unknown> | null;
    consent?: boolean | null;
    lookbackDays?: string;
  }) {
    const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
    const calls: FetchCall[] = [];
    const hold = opts.hold ?? holdRow();
    const appointment =
      opts.appointment === null
        ? null
        : {
            id: apptId,
            lead_id: leadId,
            status: 'aceptado',
            channel: 'web',
            confirmed_by_client: true,
            confirmed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            ...(opts.appointment || {}),
          };
    const consent = opts.consent === undefined ? true : opts.consent;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body ? String(init.body) : undefined });

      if (url.includes('/rpc/lv_recover_missing_meta_schedule_outbox')) {
        return jsonResponse(0);
      }
      if (url.includes('/rpc/lv_recover_missing_meta_lead_outbox')) {
        return jsonResponse(0);
      }
      if (url.includes('meta_ads_consent_ledger')) {
        return jsonResponse([]);
      }
      if (
        url.includes('meta_capi_outbox') &&
        method === 'GET' &&
        url.includes('status=eq.review_hold')
      ) {
        return jsonResponse([hold]);
      }
      if (url.includes('meta_capi_outbox') && method === 'GET' && url.includes('status=eq.pending')) {
        return jsonResponse([]);
      }
      if (url.includes('meta_capi_outbox') && method === 'PATCH') {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        patches.push({ id, body });
        return jsonResponse([{ id }]);
      }
      if (url.includes('/rest/v1/appointments')) {
        return jsonResponse(appointment ? [appointment] : []);
      }
      if (url.includes('/rest/v1/leads')) {
        return jsonResponse([{ meta_ads_consent: consent }]);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const service = buildService(
      opts.lookbackDays
        ? { META_SCHEDULE_RECOVER_LOOKBACK_DAYS: opts.lookbackDays }
        : {},
    );
    (service as unknown as { enabled: boolean }).enabled = true;
    await service.tick();
    return { patches, calls };
  }

  it('promueve a pending solo si consent+confirmación+canal web+lookback OK', async () => {
    const { patches } = await runPromoteTick({});
    expect(patches.some((p) => p.id === holdId && p.body.status === 'pending')).toBe(
      true,
    );
  });

  it('no promueve si consent no es true (cancela)', async () => {
    const { patches } = await runPromoteTick({ consent: false });
    expect(patches.some((p) => p.body.status === 'pending')).toBe(false);
    expect(
      patches.some(
        (p) =>
          p.id === holdId &&
          p.body.status === 'cancelled' &&
          p.body.last_error === 'ads_consent_revoked',
      ),
    ).toBe(true);
  });

  it('no promueve si falta confirmed_by_client', async () => {
    const { patches } = await runPromoteTick({
      appointment: { confirmed_by_client: false },
    });
    expect(patches.some((p) => p.body.status === 'pending')).toBe(false);
    expect(
      patches.some(
        (p) =>
          p.body.status === 'cancelled' &&
          p.body.last_error === 'recovered_client_confirmation_missing',
      ),
    ).toBe(true);
  });

  it('no promueve si canal no es web', async () => {
    const { patches } = await runPromoteTick({
      appointment: { channel: 'whatsapp' },
    });
    expect(patches.some((p) => p.body.status === 'pending')).toBe(false);
    expect(
      patches.some(
        (p) =>
          p.body.status === 'cancelled' &&
          p.body.last_error === 'recovered_channel_not_web',
      ),
    ).toBe(true);
  });

  it('no promueve si confirmed_at fuera del lookback', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { patches } = await runPromoteTick({
      appointment: { confirmed_at: old },
      lookbackDays: '7',
    });
    expect(patches.some((p) => p.body.status === 'pending')).toBe(false);
    // Fuera de lookback: skip sin cancelar (conserva hold).
    expect(patches.some((p) => p.id === holdId)).toBe(false);
  });

  it('no promueve BM/WhatsApp aunque last_error sea recovered_*', async () => {
    const { patches } = await runPromoteTick({
      hold: holdRow({
        payload: {
          action_source: 'business_messaging',
          channel_kind: 'whatsapp',
          appointment_id: apptId,
        },
      }),
    });
    expect(patches.some((p) => p.body.status === 'pending')).toBe(false);
  });
});

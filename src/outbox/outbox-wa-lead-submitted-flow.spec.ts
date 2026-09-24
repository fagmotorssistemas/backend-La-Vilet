/**
 * Recorrido Nest real LeadSubmitted (BM): claim → consent → Graph simulado → resultado.
 * Graph = mock de fetch sobre MetaCapiService.sendToMeta (no sonda independiente).
 * No amplía allowlist con TestEvent. Datos sintéticos solo en este spec.
 */
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { OutboxService } from './outbox.service';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { SqliteOutboxStore } from '../database/sqlite-store';
import { EventsService } from '../events/events.service';
import { EnqueueEventDto } from '../events/dto/enqueue-event.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

const WABA = '1410020224338488';
const MSG_DATASET = '4419657838288963';
const WEB_DATASET = '923439043758658';
const TENANT = 'a1b2c3d4-0001-4000-8000-000000000001';
const PROJECT = 'b1b2c3d4-0001-4000-8000-000000000001';
const CONTACT = 'c1c2c3c4-0001-4000-8000-000000000001';
const LEAD = 'd1d2d3d4-0001-4000-8000-000000000001';
const EVENT_ID = '20273482-aaaa-4bbb-8ccc-d2681cf16307';
const CTWA = 'synthetic_local_ctwa_clid_nest_flow';

function lsGraphPayload(eventId = EVENT_ID) {
  return {
    data: [
      {
        event_name: 'LeadSubmitted',
        event_time: 1_700_000_000,
        event_id: eventId,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: {
          ctwa_clid: CTWA,
          whatsapp_business_account_id: WABA,
        },
      },
    ],
  };
}

function lsRedacted(overrides: Record<string, unknown> = {}) {
  return {
    event_name: 'LeadSubmitted',
    tenant_id: TENANT,
    project_id: PROJECT,
    contact_id: CONTACT,
    lead_id: LEAD,
    ...overrides,
  };
}

describe('OutboxService — LeadSubmitted Nest flow (Graph simulado)', () => {
  const originalFetch = global.fetch;
  let db: Database.Database;
  let store: SqliteOutboxStore;
  let database: DatabaseService;
  let graphCalls: Array<{
    url: string;
    auth: string;
    eventName?: string;
  }>;
  let leadConsent: boolean | null;
  let leadTenant: string;
  let leadProject: string;
  let leadHttpOk: boolean;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteOutboxStore(db);
    store.migrate();
    graphCalls = [];
    leadConsent = true;
    leadTenant = TENANT;
    leadProject = PROJECT;
    leadHttpOk = true;

    database = {
      claimPending: (
        limit: number,
        lane: 'test' | 'live',
        opts?: { excludeSchedule?: boolean; excludeLeadSubmitted?: boolean },
      ) => store.claimPending(limit, lane, opts),
      getOutboxById: (id: number) => store.getOutboxById(id),
      markSent: (id: number, body: unknown) => store.markSent(id, body),
      markRetry: (id: number, error: string, next: string, dead: boolean) =>
        store.markRetry(id, error, next, dead),
      cancelProcessingIfRevoked: (id: number) =>
        store.cancelProcessingIfRevoked(id),
      releaseProcessingToPending: (id: number, reason: string) =>
        store.releaseProcessingToPending(id, reason),
      purgeOld: () => 0,
      isConsentRevoked: () => false,
      insertOutbox: (row: Parameters<SqliteOutboxStore['insertOutbox']>[0]) =>
        store.insertOutbox(row),
    } as unknown as DatabaseService;

    global.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/rest/v1/leads')) {
          if (!leadHttpOk) {
            return { ok: false, status: 503, json: async () => [] } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                meta_ads_consent: leadConsent,
                tenant_id: leadTenant,
                project_id: leadProject,
              },
            ],
          } as Response;
        }

        // Bitácora CRM (no Graph): no cuenta como envío Meta.
        if (url.includes('/rest/v1/rpc/lv_log_meta_conversion')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          } as Response;
        }

        const headers = (init?.headers || {}) as Record<string, string>;
        const body = JSON.parse(String(init?.body || '{}')) as {
          data?: Array<{ event_name?: string }>;
        };
        graphCalls.push({
          url,
          auth: String(headers.Authorization || ''),
          eventName: body.data?.[0]?.event_name,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events_received: 1,
            fbtrace_id: 'NEST_LOCAL_MOCK_FBTRACE',
          }),
        } as Response;
      },
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    db.close();
    jest.restoreAllMocks();
  });

  function makeMeta() {
    return new MetaCapiService({
      get: (key: string) =>
        ({
          META_MODE: 'live',
          META_DATASET_ID: WEB_DATASET,
          META_API_VERSION: 'v21.0',
          META_CAPI_ACCESS_TOKEN: 'web-token-LOCAL-ONLY',
          META_WA_CAPI_ACCESS_TOKEN: 'wa-token-LOCAL-ONLY',
          META_WABA_ID: WABA,
          META_MESSAGING_DATASET_ID: MSG_DATASET,
          META_CORE_SETUP_CONSERVATIVE: 'true',
          META_HTTP_TIMEOUT_MS: '5000',
        })[key],
    } as unknown as ConfigService);
  }

  function makeOutbox(deliveryOn: boolean, maxAttempts = 8) {
    return new OutboxService(database, makeMeta(), {
      get: (key: string) =>
        ({
          OUTBOX_BATCH_SIZE: '20',
          OUTBOX_MAX_ATTEMPTS: String(maxAttempts),
          OUTBOX_RETENTION_DAYS: '90',
          META_SCHEDULE_DELIVERY_ENABLED: 'false',
          META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED: deliveryOn
            ? 'true'
            : 'false',
          SUPABASE_URL: 'http://127.0.0.1:54321',
          SUPABASE_SERVICE_ROLE_KEY: 'local-service-role',
        })[key],
    } as unknown as ConfigService);
  }

  function insertLs(opts?: {
    idempotencyKey?: string;
    eventId?: string;
    redacted?: Record<string, unknown>;
  }) {
    return store.insertOutbox({
      idempotency_key: opts?.idempotencyKey || `wa_lead_submitted:${LEAD}`,
      event_id: opts?.eventId || EVENT_ID,
      event_name: 'LeadSubmitted',
      event_time: 1_700_000_000,
      payload_redacted: lsRedacted(opts?.redacted),
      graph_payload: lsGraphPayload(opts?.eventId || EVENT_ID),
      dataset_id: MSG_DATASET,
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: LEAD,
      ads_consent_required: true,
    });
  }

  it('happy path: claim → consent true → Graph WA v26 dataset mensajería → sent', async () => {
    insertLs();
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status, dataset_id, event_id FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string; dataset_id: string; event_id: string };

    expect(row.status).toBe('sent');
    expect(row.dataset_id).toBe(MSG_DATASET);
    expect(row.event_id).toBe(EVENT_ID);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain(
      `graph.facebook.com/v26.0/${MSG_DATASET}/events`,
    );
    expect(graphCalls[0].url).not.toContain(WEB_DATASET);
    expect(graphCalls[0].auth).toBe('Bearer wa-token-LOCAL-ONLY');
    expect(graphCalls[0].auth).not.toContain('web-token');
    expect(graphCalls[0].eventName).toBe('LeadSubmitted');
  });

  it('consent false revoca antes del envío (cancel; sin Graph)', async () => {
    leadConsent = false;
    insertLs();
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string };
    expect(row.status).toBe('cancelled');
    expect(graphCalls).toHaveLength(0);
  });

  it('consent null/ausente → permite Graph (configuración operativa)', async () => {
    leadConsent = null;
    insertLs();
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status, last_error FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string; last_error: string | null };
    expect(row.status).toBe('sent');
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].eventName).toBe('LeadSubmitted');
  });

  it('tenant mismatch → hold pending sin Graph', async () => {
    leadTenant = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    insertLs();
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status, last_error FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string; last_error: string | null };
    expect(row.status).toBe('pending');
    expect(String(row.last_error || '')).toContain('tenant_scope_mismatch');
    expect(graphCalls).toHaveLength(0);
  });

  it('project mismatch → hold pending sin Graph', async () => {
    leadProject = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    insertLs();
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status, last_error FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string; last_error: string | null };
    expect(row.status).toBe('pending');
    expect(String(row.last_error || '')).toContain('project_scope_mismatch');
    expect(graphCalls).toHaveLength(0);
  });

  it('sin contact_id → hold contact_scope_required', async () => {
    insertLs({ redacted: { contact_id: null } });
    await makeOutbox(true).tick();

    const row = db
      .prepare(
        `SELECT status, last_error FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string; last_error: string | null };
    expect(row.status).toBe('pending');
    expect(String(row.last_error || '')).toContain('contact_scope_required');
    expect(graphCalls).toHaveLength(0);
  });

  it('delivery OFF: LS queda pending; Lead web sí se envía con token web', async () => {
    insertLs();
    store.insertOutbox({
      idempotency_key: 'lead:web-keep',
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event_name: 'Lead',
      event_time: 1,
      payload_redacted: { event_name: 'Lead' },
      graph_payload: {
        data: [{ event_name: 'Lead', action_source: 'website', user_data: {} }],
      },
      dataset_id: WEB_DATASET,
      delivery_lane: 'live',
      visitor_key: null,
      lead_id: 'lead-web',
      ads_consent_required: false,
    });

    await makeOutbox(false).tick();

    const ls = db
      .prepare(
        `SELECT status FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string };
    const lead = db
      .prepare(`SELECT status FROM outbox_events WHERE event_name = 'Lead'`)
      .get() as { status: string };

    expect(ls.status).toBe('pending');
    expect(lead.status).toBe('sent');
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].eventName).toBe('Lead');
    expect(graphCalls[0].auth).toBe('Bearer web-token-LOCAL-ONLY');
    expect(graphCalls[0].url).toContain(`/v21.0/${WEB_DATASET}/events`);
  });

  it('duplicado mismo idempotency_key no inserta segunda fila', () => {
    const a = insertLs();
    const b = insertLs();
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('mismo event_id con distinta idempotency_key puede coexistir (UNIQUE es la key)', () => {
    insertLs({ idempotencyKey: 'wa_lead_submitted:key-a' });
    insertLs({ idempotencyKey: 'wa_lead_submitted:key-b' });
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM outbox_events WHERE event_id = ?`)
      .get(EVENT_ID) as { c: number };
    expect(count.c).toBe(2);
  });

  it('reintento: 500 retryable → failed + next_attempt; segundo tick con 200 → sent', async () => {
    insertLs();
    let graphHits = 0;
    global.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/rest/v1/leads')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                meta_ads_consent: true,
                tenant_id: TENANT,
                project_id: PROJECT,
              },
            ],
          } as Response;
        }
        if (url.includes('/rest/v1/rpc/lv_log_meta_conversion')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          } as Response;
        }
        graphHits += 1;
        const headers = (init?.headers || {}) as Record<string, string>;
        graphCalls.push({
          url,
          auth: String(headers.Authorization || ''),
          eventName: 'LeadSubmitted',
        });
        if (graphHits === 1) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              error: { message: 'temporary', code: 1, is_transient: true },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events_received: 1,
            fbtrace_id: 'NEST_RETRY_OK',
          }),
        } as Response;
      },
    ) as typeof fetch;

    const outbox = makeOutbox(true);
    await outbox.tick();

    let row = db
      .prepare(
        `SELECT status, next_attempt_at, attempt_count FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as {
      status: string;
      next_attempt_at: string | null;
      attempt_count: number;
    };
    expect(row.status).toBe('failed');
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.attempt_count).toBeGreaterThanOrEqual(1);

    // Liberar backoff para el segundo tick.
    db.prepare(
      `UPDATE outbox_events SET status = 'pending', next_attempt_at = NULL WHERE event_name = 'LeadSubmitted'`,
    ).run();

    await outbox.tick();
    row = db
      .prepare(
        `SELECT status FROM outbox_events WHERE event_name = 'LeadSubmitted'`,
      )
      .get() as { status: string };
    expect(row.status).toBe('sent');
    expect(graphHits).toBe(2);
    expect(
      graphCalls.every((c) => c.auth === 'Bearer wa-token-LOCAL-ONLY'),
    ).toBe(true);
  });

  it('enqueue Nest real: BM exige CTWA y dataset mensajería; rechaza TestEvent en DTO path', () => {
    const meta = makeMeta();
    const events = new EventsService(database, meta);

    const ok = events.enqueue({
      idempotency_key: `wa_lead_submitted:${LEAD}:enqueue`,
      ads_consent: true,
      phone: '593990000001',
      delivery_lane: 'live',
      event_name: 'LeadSubmitted',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      ctwa_clid: CTWA,
      whatsapp_business_account_id: WABA,
      messaging_dataset_id: MSG_DATASET,
      lead_id: LEAD,
      tenant_id: TENANT,
      project_id: PROJECT,
      contact_id: CONTACT,
      event_id: EVENT_ID,
    } as EnqueueEventDto);

    expect(ok.dataset_id).toBe(MSG_DATASET);
    expect(ok.dataset_id).not.toBe(WEB_DATASET);

    expect(() =>
      events.enqueue({
        idempotency_key: 'x',
        ads_consent: true,
        phone: '593990000001',
        delivery_lane: 'live',
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        whatsapp_business_account_id: WABA,
        messaging_dataset_id: MSG_DATASET,
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_identifiers_required/);

    // Allowlist Nest (DTO): TestEvent no entra a /v1/events — no ampliar a prod.
    const forbidden = plainToInstance(EnqueueEventDto, {
      idempotency_key: 'testevent-forbidden',
      ads_consent: true,
      phone: '593990000001',
      delivery_lane: 'live',
      event_name: 'TestEvent',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      ctwa_clid: CTWA,
      whatsapp_business_account_id: WABA,
      messaging_dataset_id: MSG_DATASET,
    });
    const errors = validateSync(forbidden);
    expect(errors.some((e) => e.property === 'event_name')).toBe(true);
  });
});

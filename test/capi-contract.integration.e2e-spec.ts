import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { OutboxService } from '../src/outbox/outbox.service';

type Fixture = Record<string, unknown> & {
  event_name: string;
  event_id: string;
  event_time: number;
  idempotency_key: string;
  delivery_lane: 'test' | 'live';
};

describe('contrato frontend/backend conciliado (integración aislada)', () => {
  const secret = 'integration-local-secret';
  const fixtures = JSON.parse(
    readFileSync('D:/FrontLaVilet/docs/CAPI_LOCAL_TEST_PAYLOADS.json', 'utf8'),
  ) as Fixture[];
  let app: INestApplication;
  let database: DatabaseService;
  let dir: string;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lavilet-capi-contract-'));
    process.env.DATABASE_PATH = join(dir, 'isolated.sqlite');
    process.env.META_MODE = 'test';
    process.env.META_TEST_EVENT_CODE = 'LOCAL_ONLY';
    process.env.META_DATASET_ID = 'WEB_DATASET_TEST_ONLY';
    process.env.META_CAPI_ACCESS_TOKEN = 'local-web-placeholder';
    process.env.META_WA_CAPI_ACCESS_TOKEN = 'local-wa-placeholder';
    process.env.META_WABA_ID = 'WABA_TEST_ONLY';
    process.env.META_MESSAGING_DATASET_ID = 'MESSAGING_DATASET_TEST_ONLY';
    process.env.META_CAPI_INTERNAL_SECRET = secret;
    process.env.OUTBOX_ENABLED = 'false';
    process.env.SUPABASE_DRAIN_ENABLED = 'false';

    originalFetch = global.fetch;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      throw new Error(`external_fetch_blocked:${String(input)}`);
    }) as typeof fetch;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/events')
      .set('X-Internal-Secret', secret)
      .send(body);

  const get = (eventId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/events/${eventId}`)
      .set('X-Internal-Secret', secret);

  it('recibe los seis eventos y ambos ViewContent conservando identidad, fecha, carril y campos', async () => {
    expect(fixtures).toHaveLength(7);
    expect(new Set(fixtures.map((item) => item.event_name))).toEqual(
      new Set([
        'ViewContent',
        'Lead',
        'AddToWishlist',
        'Schedule',
        'LeadSubmitted',
        'Purchase',
      ]),
    );

    for (const fixture of fixtures) {
      const response = await post(fixture).expect(202);
      expect(response.body).toMatchObject({
        accepted: true,
        duplicate: false,
        event_id: fixture.event_id,
        event_time: fixture.event_time,
        delivery_lane: fixture.delivery_lane,
        delivery_outcome: 'backend_accepted',
      });
      const row = database.getLatestByEventId(fixture.event_id);
      expect(row).toBeDefined();
      expect(row?.event_id).toBe(fixture.event_id);
      expect(row?.event_time).toBe(fixture.event_time);
      expect(row?.delivery_lane).toBe(fixture.delivery_lane);
      const redacted = JSON.parse(row!.payload_redacted) as Record<
        string,
        unknown
      >;
      const graph = JSON.parse(row!.graph_payload) as {
        data: Array<Record<string, unknown>>;
      };
      expect(graph.data[0]).toMatchObject({
        event_name: fixture.event_name,
        event_id: fixture.event_id,
        event_time: fixture.event_time,
        action_source: fixture.action_source,
      });
      for (const field of [
        'lv_internal_subtype',
        'unit_id',
        'sale_id',
        'sale_at',
        'registered_at',
      ]) {
        if (fixture[field] != null)
          expect(redacted[field]).toBe(fixture[field]);
      }
      if (fixture.event_name === 'LeadSubmitted') {
        expect(row?.dataset_id).toBe(fixture.messaging_dataset_id);
        expect(graph.data[0].user_data).toMatchObject({
          ctwa_clid: fixture.ctwa_clid,
          whatsapp_business_account_id: fixture.whatsapp_business_account_id,
        });
      }
      if (fixture.event_name === 'Purchase') {
        expect(graph.data[0].custom_data).toMatchObject({
          value: fixture.value,
          currency: fixture.currency,
        });
      }
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('deduplica la repetición idéntica y rechaza la incompatible con 409', async () => {
    const fixture = fixtures.find((item) => item.event_name === 'Lead')!;
    const duplicate = await post(fixture).expect(202);
    expect(duplicate.body).toMatchObject({
      accepted: false,
      duplicate: true,
      event_id: fixture.event_id,
    });
    const conflict = await post({
      ...fixture,
      event_time: fixture.event_time + 1,
    }).expect(409);
    expect(JSON.stringify(conflict.body)).toContain('idempotency_key_conflict');
  });

  it('recibe QualifiedLead producido por el staging y conserva evidencia interna', async () => {
    const leadId = '71000000-0000-4000-8000-000000000001';
    const fixture = {
      event_name: 'QualifiedLead',
      idempotency_key: `wa_crm_qualified:${leadId}`,
      event_id: '72000000-0000-4000-8000-000000000001',
      event_time: 1790247601,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      lead_id: leadId,
      tenant_id: '73000000-0000-4000-8000-000000000001',
      project_id: '74000000-0000-4000-8000-000000000001',
      contact_id: 'contact-qualified',
      ctwa_clid: 'ctwa-qualified',
      whatsapp_business_account_id: 'WABA_TEST_ONLY',
      messaging_dataset_id: 'MESSAGING_DATASET_TEST_ONLY',
      qualification_source: 'crm_persisted_evaluation',
      temperature: 'tibio',
      evidence_labels: ['financiamiento', 'cita_solicitada'],
      delivery_lane: 'test',
      ads_consent: true,
    };
    const accepted = await post(fixture).expect(202);
    expect(accepted.body).toMatchObject({
      accepted: true,
      delivery: expect.stringContaining('held:'),
      delivery_outcome: 'backend_accepted',
    });
    const row = database.getLatestByEventId(fixture.event_id)!;
    const redacted = JSON.parse(row.payload_redacted) as Record<
      string,
      unknown
    >;
    const graph = JSON.parse(row.graph_payload) as Record<string, unknown>;
    expect(redacted).toMatchObject({
      temperature: 'tibio',
      evidence_labels: ['financiamiento', 'cita_solicitada'],
      qualification_source: 'crm_persisted_evaluation',
    });
    expect(JSON.stringify(graph)).not.toContain('evidence_labels');

    await post(fixture).expect(202);
    await post({ ...fixture, temperature: 'caliente' }).expect(409);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('GET expone los seis delivery_outcome sin confundir aceptación interna con Meta', async () => {
    const outcomes = [
      'backend_accepted',
      'transport_failed',
      'meta_rejected',
      'meta_unverified',
      'meta_accepted',
      'cancelled',
    ] as const;
    const ids = outcomes.map(
      (_, index) => `90000000-0000-4000-8000-00000000000${index}`,
    );
    for (let index = 0; index < outcomes.length; index += 1) {
      await post({
        event_name: 'Lead',
        idempotency_key: `lead:outcome:${outcomes[index]}`,
        event_id: ids[index],
        event_time: 1790252000 + index,
        action_source: 'website',
        ads_consent: true,
        delivery_lane: 'test',
      }).expect(202);
    }
    const claimed = database.claimPending(100, 'test');
    const byId = new Map(claimed.map((row) => [row.event_id, row]));
    database.markRetry(
      byId.get(ids[1])!.id,
      'simulated_network_failure',
      new Date(Date.now() + 60_000).toISOString(),
      false,
      'transport_failed',
      { network_error: true },
    );
    database.markRetry(
      byId.get(ids[2])!.id,
      'simulated_meta_rejection',
      new Date(Date.now() + 60_000).toISOString(),
      true,
      'meta_rejected',
      { http_status: 400, error_code: 100 },
    );
    database.markRetry(
      byId.get(ids[3])!.id,
      'simulated_unverified_response',
      new Date(Date.now() + 60_000).toISOString(),
      true,
      'meta_unverified',
      { http_status: 200, events_received: 0 },
    );
    database.markSent(byId.get(ids[4])!.id, {
      http_status: 200,
      events_received: 1,
      fbtrace_id: 'LOCAL_SIMULATED',
    });
    database.cancelByEventIds([ids[5]], 'simulated_consent_revocation');
    database.releaseProcessingToPending(
      byId.get(ids[0])!.id,
      'simulated_backend_hold',
    );

    for (let index = 0; index < outcomes.length; index += 1) {
      const response = await get(ids[index]).expect(200);
      expect(response.body.delivery_outcome).toBe(outcomes[index]);
      expect(response.body.api_accepted).toBe(
        outcomes[index] === 'meta_accepted',
      );
    }
  });

  it('separa carriles y retiene Purchase cuando faltan fechas originales', async () => {
    const live = await post({
      event_name: 'Lead',
      idempotency_key: 'lead:live-held-in-test',
      event_id: 'a0000000-0000-4000-8000-000000000001',
      event_time: 1790253000,
      action_source: 'website',
      ads_consent: true,
      delivery_lane: 'live',
    }).expect(202);
    expect(live.body.delivery).toBe('held:lane_mismatch');

    const missingDates = await post({
      event_name: 'Purchase',
      idempotency_key: 'purchase:99999999-9999-4999-8999-999999999999',
      event_id: 'a0000000-0000-4000-8000-000000000002',
      event_time: 1790253001,
      action_source: 'system_generated',
      ads_consent: true,
      delivery_lane: 'test',
      sale_id: '99999999-9999-4999-8999-999999999999',
      lead_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      unit_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      value: 210000,
      currency: 'USD',
    }).expect(202);
    expect(missingDates.body.delivery_outcome).toBe('backend_accepted');
    expect(
      database.getLatestByEventId(missingDates.body.event_id)?.status,
    ).toBe('pending');

    process.env.META_PURCHASE_DELIVERY_ENABLED = 'true';
    process.env.META_PURCHASE_ACTIVATED_AT = '2026-09-24T00:00:00.000Z';
    await app.get(OutboxService).tick();
    expect(
      database.getLatestByEventId(missingDates.body.event_id)?.last_error,
    ).toBe('purchase_registered_at_required');
    expect(
      database.getLatestByEventId(missingDates.body.event_id)?.status,
    ).toBe('pending');
  });
});

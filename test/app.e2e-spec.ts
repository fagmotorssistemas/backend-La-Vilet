import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

type HealthBody = { ok: boolean; mode: string };
type EnqueueBody = {
  accepted?: boolean;
  duplicate?: boolean;
  delivery?: string;
  event_id?: string;
};

describe('lavilet-meta-capi (e2e)', () => {
  let app: INestApplication<App>;
  const secret = 'test-internal-secret-123456';
  const originalFetch = global.fetch;
  let dir: string;

  beforeAll(() => {
    // Aislamiento total: ninguna llamada de red, aunque el .env local
    // apunte a Supabase o Meta reales.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      throw new Error(`external_fetch_blocked:${String(input)}`);
    }) as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lavilet-capi-e2e-'));
    process.env.META_MODE = 'disabled';
    process.env.META_DATASET_ID = '923439043758658';
    // Los fixtures usan event_time fijos (pueden tener más de 7 días).
    process.env.META_EVENT_MAX_AGE_CHECK_ENABLED = 'false';
    process.env.META_CAPI_ACCESS_TOKEN = '';
    process.env.META_WA_CAPI_ACCESS_TOKEN = '';
    process.env.META_TEST_EVENT_CODE = '';
    process.env.META_CAPI_INTERNAL_SECRET = secret;
    process.env.DATABASE_PATH = join(dir, 'test-e2e.db');
    process.env.OUTBOX_ENABLED = 'false';
    process.env.SUPABASE_DRAIN_ENABLED = 'false';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.META_WA_CTWA_RECONCILE_ENABLED = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede retener el WAL un instante.
    }
  });

  it('health sin secretos', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    const body = res.body as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('disabled');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(
      String(process.env.META_WA_APP_SECRET || 'never'),
    );
    expect(serialized).not.toMatch(/EAAG|access_token/i);
  });

  it('rechaza sin secreto interno', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        event_name: 'Lead',
        idempotency_key: 'lead:x',
        action_source: 'website',
        ads_consent: true,
        phone: '0991234567',
      })
      .expect(401);
  });

  it('encola Lead con idempotencia (sin enviar a Meta)', async () => {
    const key = `lead:e2e-${Date.now()}`;
    const payload = {
      event_name: 'Lead',
      idempotency_key: key,
      action_source: 'website',
      ads_consent: true,
      phone: '0991234567',
      email: 'real@example.com',
      event_source_url: 'https://www.lavilett.com/inicio',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/events')
      .set('X-Internal-Secret', secret)
      .send(payload)
      .expect(202);
    const firstBody = first.body as EnqueueBody;
    expect(firstBody.accepted).toBe(true);
    expect(firstBody.delivery).toContain('held');

    const second = await request(app.getHttpServer())
      .post('/api/v1/events')
      .set('X-Internal-Secret', secret)
      .send(payload)
      .expect(202);
    const secondBody = second.body as EnqueueBody;
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.event_id).toBe(firstBody.event_id);
  });

  it('rechaza sin ads_consent', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .set('X-Internal-Secret', secret)
      .send({
        event_name: 'Lead',
        idempotency_key: 'lead:no-consent',
        action_source: 'website',
        ads_consent: false,
        phone: '0991234567',
      })
      .expect(400);
  });
});

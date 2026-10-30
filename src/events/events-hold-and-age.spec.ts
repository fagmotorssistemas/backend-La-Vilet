import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import { EventsService } from './events.service';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';

const LEAD = 'aaaaaaaa-1111-4111-8111-000000000001';

function setup(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-age-'));
  const values: Record<string, string> = {
    DATABASE_PATH: path.join(dir, 'test.db'),
    META_MODE: 'live',
    META_DATASET_ID: 'WEB_DS',
    META_CAPI_ACCESS_TOKEN: 'web-token',
    META_WA_CAPI_ACCESS_TOKEN: 'wa-token',
    META_WABA_ID: 'WABA_1',
    META_MESSAGING_DATASET_ID: 'MSG_DS',
    ...env,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  const db = new DatabaseService(config);
  db.onModuleInit();
  const service = new EventsService(db, new MetaCapiService(config));
  const cleanup = () => {
    db.onModuleDestroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows puede retener el WAL.
    }
  };
  return { service, cleanup };
}

let seq = 0;
function dto(overrides: Partial<EnqueueEventDto>): EnqueueEventDto {
  seq += 1;
  return {
    event_name: 'Schedule',
    idempotency_key: `k:hold-age:${seq}`,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    ads_consent: true,
    delivery_lane: 'live',
    lead_id: LEAD,
    ...overrides,
  } as EnqueueEventDto;
}

const leadSubmitted = (overrides: Partial<EnqueueEventDto> = {}) =>
  dto({
    event_name: 'LeadSubmitted',
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    ctwa_clid: 'CTWA-1',
    whatsapp_business_account_id: 'WABA_1',
    messaging_dataset_id: 'MSG_DS',
    ...overrides,
  });

describe('POST /v1/events — retención y antigüedad', () => {
  it('Schedule con su interruptor apagado responde held (no queued)', () => {
    const { service, cleanup } = setup();
    expect(service.enqueue(dto({})).delivery).toBe(
      'held:schedule_delivery_inactive',
    );
    cleanup();
  });

  it('Schedule con su interruptor encendido responde queued', () => {
    const { service, cleanup } = setup({
      META_SCHEDULE_DELIVERY_ENABLED: 'true',
    });
    expect(service.enqueue(dto({})).delivery).toBe('queued');
    cleanup();
  });

  it('LeadSubmitted con su interruptor apagado responde held', () => {
    const { service, cleanup } = setup();
    expect(service.enqueue(leadSubmitted()).delivery).toBe(
      'held:wa_lead_submitted_delivery_inactive',
    );
    cleanup();
  });

  it('LeadSubmitted con su interruptor encendido responde queued', () => {
    const { service, cleanup } = setup({
      META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED: 'true',
    });
    expect(service.enqueue(leadSubmitted()).delivery).toBe('queued');
    cleanup();
  });

  it('rechaza un evento de hace 8 días con el control de antigüedad activo', () => {
    const { service, cleanup } = setup({
      META_EVENT_MAX_AGE_CHECK_ENABLED: 'true',
    });
    const old = dto({
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000) - 8 * 86400,
    });
    expect(() => service.enqueue(old)).toThrow(BadRequestException);
    expect(() => service.enqueue(old)).toThrow(/event_time_too_old/);
    cleanup();
  });

  it('acepta un evento de hace 6 días con el control activo', () => {
    const { service, cleanup } = setup({
      META_EVENT_MAX_AGE_CHECK_ENABLED: 'true',
    });
    const res = service.enqueue(
      dto({
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000) - 6 * 86400,
      }),
    );
    expect(res.accepted).toBe(true);
    cleanup();
  });
});

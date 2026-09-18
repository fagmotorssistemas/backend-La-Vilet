/**
 * Rechazo BM sin dataset/IDs; nunca fallback al dataset web.
 * Schedule BM bloqueado.
 */
import { BadRequestException } from '@nestjs/common';
import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';

describe('EventsService — Business Messaging gates', () => {
  function makeService() {
    const db = {
      insertOutbox: jest.fn((row: { dataset_id: string }) => ({
        inserted: true,
        blocked_by_consent: false,
        row: {
          event_id: 'e1',
          event_name: 'Lead',
          event_time: 1,
          status: 'pending',
          delivery_lane: 'live',
          dataset_id: row.dataset_id,
        },
      })),
    } as unknown as DatabaseService;

    const meta = {
      mode: 'disabled',
      datasetId: 'WEB_PIXEL_DATASET',
      buildFbc: () => null,
      buildGraphPayload: () => ({
        eventId: 'e1',
        eventTime: 1,
        payload: { data: [] },
        redacted: {},
      }),
      assertSendAllowed: () => ({ ok: false, reason: 'META_MODE=disabled' }),
    } as unknown as MetaCapiService;

    return { service: new EventsService(db, meta), db, meta };
  }

  const base = {
    idempotency_key: 'k1',
    ads_consent: true,
    phone: '593990000000',
    delivery_lane: 'live' as const,
  };

  it('rechaza Schedule + business_messaging (no verificado)', () => {
    const { service } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'Schedule',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'msg-ds',
      } as EnqueueEventDto),
    ).toThrow(BadRequestException);
    try {
      service.enqueue({
        ...base,
        event_name: 'Schedule',
        action_source: 'business_messaging',
        messaging_dataset_id: 'msg-ds',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
      } as EnqueueEventDto);
    } catch (e) {
      expect((e as BadRequestException).message).toContain(
        'business_messaging_schedule_not_supported_by_meta',
      );
    }
  });

  it('rechaza BM sin messaging_dataset_id (no usa WEB_PIXEL_DATASET)', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'Lead',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_identifiers_required/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('LeadSubmitted BM válido usa messaging dataset (no pixel web)', () => {
    const { service, db } = makeService();
    const result = service.enqueue({
      ...base,
      event_name: 'LeadSubmitted',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      ctwa_clid: 'Aff-LS',
      whatsapp_business_account_id: 'waba',
      messaging_dataset_id: 'MSG_DATASET_LS',
    } as EnqueueEventDto);
    expect(result.dataset_id).toBe('MSG_DATASET_LS');
    expect(result.dataset_id).not.toBe('WEB_PIXEL_DATASET');
  });

  it('LeadSubmitted BM sin ctwa_clid se rechaza', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'msg-ds',
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_identifiers_required/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('rechaza WABA igual al messaging dataset', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'SAME_ID',
        messaging_dataset_id: 'SAME_ID',
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_waba_must_not_equal_dataset/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('rechaza messaging dataset igual al pixel web', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'WEB_PIXEL_DATASET',
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_dataset_must_not_be_web_pixel/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });
});

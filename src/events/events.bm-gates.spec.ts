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
      messagingDatasetId: 'MSG_DATASET_LS',
      wabaId: 'waba',
      buildFbc: () => null,
      buildGraphPayload: () => ({
        eventId: 'e1',
        eventTime: 1,
        payload: { data: [] },
        redacted: {},
      }),
      assertSendAllowed: () => ({ ok: false, reason: 'META_MODE=disabled' }),
      assertSendAllowedFor: () => ({ ok: false, reason: 'META_MODE=disabled' }),
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

  it('rechaza Lead genérico en BM: solo LeadSubmitted usa ese canal', () => {
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
    ).toThrow(/business_messaging_lead_submitted_only/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('LeadSubmitted exige conjuntamente source BM y canal whatsapp', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'website',
      } as EnqueueEventDto),
    ).toThrow(/lead_submitted_requires_business_messaging/);
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'msg-ds',
      } as EnqueueEventDto),
    ).toThrow(/lead_submitted_requires_whatsapp_channel/);
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

  it('QualifiedLead acepta tibio o caliente con motivos internos y destino WA', () => {
    const { service, db } = makeService();
    const result = service.enqueue({
      ...base,
      event_name: 'QualifiedLead',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      ctwa_clid: 'Aff-QL',
      whatsapp_business_account_id: 'waba',
      messaging_dataset_id: 'MSG_DATASET_LS',
      lead_id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      contact_id: 'contact-1',
      temperature: 'tibio',
      evidence_labels: ['presupuesto_confirmado'],
      qualification_source: 'crm_persisted_evaluation',
      idempotency_key: 'wa_crm_qualified:11111111-1111-4111-8111-111111111111',
    } as EnqueueEventDto);
    expect(result.dataset_id).toBe('MSG_DATASET_LS');
    const inserted = (db.insertOutbox as jest.Mock).mock.calls[0][0];
    expect(inserted.payload_redacted).toMatchObject({
      temperature: 'tibio',
      evidence_labels: ['presupuesto_confirmado'],
    });
    expect(inserted.graph_payload).not.toHaveProperty('temperature');
  });

  it('QualifiedLead rechaza clasificación sin scope o motivos', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'QualifiedLead',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff-QL',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'MSG_DATASET_LS',
        temperature: 'caliente',
        qualification_source: 'crm_persisted_evaluation',
      } as EnqueueEventDto),
    ).toThrow(/qualified_lead_scope_required/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });

  it('QualifiedLead no acepta un cambio de calificación bajo la misma idempotencia', () => {
    const { service, db } = makeService();
    (db.insertOutbox as jest.Mock).mockReturnValue({
      inserted: false,
      blocked_by_consent: false,
      row: {
        event_id: 'e1',
        event_name: 'QualifiedLead',
        event_time: 1,
        status: 'pending',
        delivery_lane: 'live',
        dataset_id: 'MSG_DATASET_LS',
        payload_redacted: JSON.stringify({
          temperature: 'tibio',
          evidence_labels: ['presupuesto_confirmado'],
          qualification_source: null,
        }),
      },
    });
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'QualifiedLead',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff-QL',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'MSG_DATASET_LS',
        lead_id: '11111111-1111-4111-8111-111111111111',
        tenant_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        contact_id: 'contact-1',
        temperature: 'caliente',
        evidence_labels: ['visita_solicitada'],
        qualification_source: 'crm_persisted_evaluation',
        idempotency_key:
          'wa_crm_qualified:11111111-1111-4111-8111-111111111111',
      } as EnqueueEventDto),
    ).toThrow(/idempotency_key_conflict/);
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

  it('rechaza destino de mensajería distinto del configurado', () => {
    const { service, db } = makeService();
    expect(() =>
      service.enqueue({
        ...base,
        event_name: 'LeadSubmitted',
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        ctwa_clid: 'Aff',
        whatsapp_business_account_id: 'waba',
        messaging_dataset_id: 'OTHER_DATASET',
      } as EnqueueEventDto),
    ).toThrow(/business_messaging_dataset_destination_mismatch/);
    expect(db.insertOutbox).not.toHaveBeenCalled();
  });
});

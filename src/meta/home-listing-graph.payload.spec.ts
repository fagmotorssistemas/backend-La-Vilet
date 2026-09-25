import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from './meta-capi.service';

function makeMeta(conservative: boolean) {
  return new MetaCapiService({
    get: (key: string) =>
      key === 'META_CORE_SETUP_CONSERVATIVE'
        ? String(conservative)
        : key === 'META_MODE'
          ? 'disabled'
          : undefined,
  } as unknown as ConfigService);
}

const unitId = 'a974716f-fd87-4cd7-aaa7-a7793a33fb3b';

describe('Graph home listing content contract (sin HTTP)', () => {
  it('conserva content_ids y content_type explícitos fuera de Core Setup', () => {
    const built = makeMeta(false).buildGraphPayload({
      eventName: 'ViewContent',
      eventId: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
      eventTime: 1_790_200_000,
      actionSource: 'website',
      contentIds: [unitId],
      contentType: 'home_listing',
    });

    const event = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toEqual({
      content_ids: [unitId],
      content_type: 'home_listing',
    });
    expect(built.redacted).toMatchObject({
      content_ids: [unitId],
      content_type: 'home_listing',
      core_setup_conservative: false,
    });
  });

  it('Core Setup preserva home_listing content_ids + content_type', () => {
    const built = makeMeta(true).buildGraphPayload({
      eventName: 'ViewContent',
      actionSource: 'website',
      contentIds: [unitId],
      contentType: 'home_listing',
      contentName: 'Unidad 208',
      contentCategory: 'suite',
    });
    const event = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toEqual({
      content_ids: [unitId],
      content_type: 'home_listing',
    });
    expect(built.redacted).toMatchObject({
      content_ids: [unitId],
      content_type: 'home_listing',
      content_name: null,
      content_category: null,
      core_setup_conservative: true,
    });
  });

  it('Core Setup antes de Graph reinyecta home_listing en cola antigua', () => {
    const meta = makeMeta(true);
    const body = {
      data: [
        {
          event_name: 'ViewContent',
          event_id: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
          custom_data: {
            content_ids: [unitId],
            content_type: 'home_listing',
            content_name: 'Unidad 208',
            content_category: 'suite',
          },
          event_source_url: 'https://preview.example/tour/unidad/u1?x=1',
        },
      ],
    };
    const next = meta.applyCoreSetupBeforeGraphSend(body);
    const event = (next.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toEqual({
      content_ids: [unitId],
      content_type: 'home_listing',
    });
    expect(event.event_source_url).toBe('https://preview.example');
  });

  it('Core Setup Purchase conserva value/currency junto a home_listing', () => {
    const built = makeMeta(true).buildGraphPayload({
      eventName: 'Purchase',
      actionSource: 'system_generated',
      contentIds: [unitId],
      contentType: 'home_listing',
      value: 150000,
      currency: 'USD',
    });
    const event = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toEqual({
      content_ids: [unitId],
      content_type: 'home_listing',
      value: 150000,
      currency: 'USD',
    });
  });

  it('no añade identificadores si el productor no los envía', () => {
    const built = makeMeta(false).buildGraphPayload({
      eventName: 'ViewContent',
      actionSource: 'website',
    });
    const event = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toBeUndefined();
  });
});

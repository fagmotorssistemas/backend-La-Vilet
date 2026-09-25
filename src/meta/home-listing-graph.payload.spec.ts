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

  it('Core Setup elimina ambos campos incluso si fueron suministrados', () => {
    const built = makeMeta(true).buildGraphPayload({
      eventName: 'ViewContent',
      actionSource: 'website',
      contentIds: [unitId],
      contentType: 'home_listing',
    });
    const event = (built.payload.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toBeUndefined();
    expect(built.redacted).toMatchObject({
      content_ids: null,
      content_type: null,
      core_setup_conservative: true,
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

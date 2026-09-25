import {
  applyCoreSetupConservativeToGraphBody,
  isCoreSetupConservativeEnabled,
  originOnlyEventSourceUrl,
} from './core-setup-conservative';

describe('core-setup-conservative', () => {
  it('originOnlyEventSourceUrl quita path, query y fragmento', () => {
    expect(
      originOnlyEventSourceUrl(
        'https://lavilet-git-review-meta-capi-ksinuevos-projects.vercel.app/tour/unidad/u1?x=1#y',
      ),
    ).toBe(
      'https://lavilet-git-review-meta-capi-ksinuevos-projects.vercel.app',
    );
    expect(originOnlyEventSourceUrl('not-a-url')).toBeUndefined();
  });

  it('elimina custom_data y limita event_source_url en payloads antiguos', () => {
    const body = {
      data: [
        {
          event_name: 'ViewContent',
          event_id: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
          event_time: 1,
          action_source: 'website',
          event_source_url:
            'https://preview.example/tour/unidad/a974716f?fbclid=1',
          user_data: { client_user_agent: 'ua' },
          custom_data: {
            content_ids: ['a974716f-fd87-4cd7-aaa7-a7793a33fb3b'],
            content_type: 'home_listing',
            content_name: 'Unidad 208',
            content_category: 'suite',
          },
        },
      ],
      test_event_code: 'TEST',
    };

    const out = applyCoreSetupConservativeToGraphBody(body);
    const event = (out.data as Array<Record<string, unknown>>)[0];
    expect(event.custom_data).toBeUndefined();
    expect(event.event_source_url).toBe('https://preview.example');
    expect(event.event_name).toBe('ViewContent');
    expect(event.event_id).toBe('123ddc30-a6dc-4861-a87e-9ea22cebd313');
    expect(event.user_data).toEqual({ client_user_agent: 'ua' });
    expect(out.test_event_code).toBe('TEST');
  });

  it('isCoreSetupConservativeEnabled default true', () => {
    expect(isCoreSetupConservativeEnabled(undefined)).toBe(true);
    expect(isCoreSetupConservativeEnabled('false')).toBe(false);
    expect(isCoreSetupConservativeEnabled('true')).toBe(true);
  });
});

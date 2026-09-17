/**
 * Inspección simulada del payload Graph (sin HTTP a Meta).
 * Schedule website vs Business Messaging (campos oficiales).
 */
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from './meta-capi.service';

function makeMeta(env: Record<string, string> = {}) {
  const config = {
    get: (key: string) =>
      ({
        META_MODE: 'disabled',
        META_CORE_SETUP_CONSERVATIVE: 'true',
        META_DATASET_ID: 'pixel-or-web-dataset',
        ...env,
      })[key],
  } as unknown as ConfigService;
  return new MetaCapiService(config);
}

describe('buildGraphPayload — Schedule (simulado, sin envío)', () => {
  it('website Schedule: shape Graph correcto; sin messaging/CTWA', () => {
    const meta = makeMeta();
    const { payload, eventId } = meta.buildGraphPayload({
      eventName: 'Schedule',
      eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      eventTime: 1720000000,
      actionSource: 'website',
      eventSourceUrl: 'https://lavilet.example/proyecto?x=1',
      match: {
        phone: '+593990000000',
        email: 'cliente@example.com',
        externalId: 'lead-uuid',
      },
      fbp: 'fb.1.1.x',
      fbc: 'fb.1.1.clid',
      clientIpAddress: '203.0.113.10',
      clientUserAgent: 'JestAgent/1.0',
    });

    const event = (payload.data as Array<Record<string, unknown>>)[0];
    const userData = event.user_data as Record<string, unknown>;

    expect(event.event_name).toBe('Schedule');
    expect(event.event_id).toBe(eventId);
    expect(event.action_source).toBe('website');
    expect(event.messaging_channel).toBeUndefined();
    expect(userData.ctwa_clid).toBeUndefined();
    expect(userData.whatsapp_business_account_id).toBeUndefined();
    expect(userData.ph).toBeTruthy();
    expect(userData.em).toBeTruthy();
    expect(userData.fbp).toBe('fb.1.1.x');
    expect(userData.fbc).toBe('fb.1.1.clid');
    expect(userData.client_ip_address).toBe('203.0.113.10');
    expect(userData.client_user_agent).toBe('JestAgent/1.0');
    // Conservador: URL solo origen.
    expect(event.event_source_url).toBe('https://lavilet.example');
    expect(event.custom_data).toBeUndefined();
  });

  it('business_messaging: ctwa_clid y WABA en user_data; no en custom_data', () => {
    const meta = makeMeta({ META_CORE_SETUP_CONSERVATIVE: 'false' });
    const { payload } = meta.buildGraphPayload({
      eventName: 'Schedule',
      actionSource: 'business_messaging',
      messagingChannel: 'whatsapp',
      ctwaClid: 'Aff-TEST-CLID',
      whatsappBusinessAccountId: 'waba-123',
      match: { phone: '593990000000' },
      contentName: 'should-stay-custom',
    });

    const event = (payload.data as Array<Record<string, unknown>>)[0];
    const userData = event.user_data as Record<string, unknown>;
    const custom = event.custom_data as Record<string, unknown> | undefined;

    expect(event.action_source).toBe('business_messaging');
    expect(event.messaging_channel).toBe('whatsapp');
    expect(userData.ctwa_clid).toBe('Aff-TEST-CLID');
    expect(userData.whatsapp_business_account_id).toBe('waba-123');
    expect(custom?.ctwa_clid).toBeUndefined();
    expect(custom?.content_name).toBe('should-stay-custom');
    // event_name Schedule bajo BM sigue sin verificación Meta allowlist.
    expect(event.event_name).toBe('Schedule');
  });
});

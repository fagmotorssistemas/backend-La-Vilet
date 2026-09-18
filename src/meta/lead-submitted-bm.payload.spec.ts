/**
 * LeadSubmitted BM payload: dataset mensajería + ctwa en user_data.
 */
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from './meta-capi.service';

describe('LeadSubmitted business_messaging payload', () => {
  it('incluye ctwa_clid y waba en user_data; no usa dataset web en build', () => {
    const config = {
      get: (key: string) => {
        const map: Record<string, string> = {
          META_MODE: 'disabled',
          META_DATASET_ID: 'WEB_PIXEL',
          META_API_VERSION: 'v21.0',
        };
        return map[key];
      },
    } as unknown as ConfigService;
    const meta = new MetaCapiService(config);
    const built = meta.buildGraphPayload({
      eventName: 'LeadSubmitted',
      actionSource: 'business_messaging',
      messagingChannel: 'whatsapp',
      ctwaClid: 'Aff-ABC',
      whatsappBusinessAccountId: 'WABA1',
      messagingDatasetId: 'MSG_DS',
      match: { phone: '593990000001', externalId: 'lead-1' },
    });
    const event = built.payload.data[0] as Record<string, unknown>;
    const userData = event.user_data as Record<string, unknown>;
    expect(event.event_name).toBe('LeadSubmitted');
    expect(event.action_source).toBe('business_messaging');
    expect(event.messaging_channel).toBe('whatsapp');
    expect(userData.ctwa_clid).toBe('Aff-ABC');
    expect(userData.whatsapp_business_account_id).toBe('WABA1');
  });
});

/**
 * LeadSubmitted / BM usa META_WA_CAPI_ACCESS_TOKEN, nunca el token web.
 */
import { ConfigService } from '@nestjs/config';
import { MetaCapiService } from './meta-capi.service';

describe('WA messaging credential lane', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeMeta(env: Record<string, string>) {
    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;
    return new MetaCapiService(config);
  }

  it('LeadSubmitted POSTea con Bearer WA y no el web', async () => {
    const authHeaders: string[] = [];
    global.fetch = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        authHeaders.push(String(headers?.Authorization || ''));
        return {
          ok: true,
          status: 200,
          json: async () => ({ events_received: 1, fbtrace_id: 'WA_MOCK' }),
        } as Response;
      },
    ) as typeof fetch;

    const meta = makeMeta({
      META_MODE: 'test',
      META_DATASET_ID: 'dataset-web',
      META_API_VERSION: 'v21.0',
      META_CAPI_ACCESS_TOKEN: 'web-token-SECRET',
      META_WA_CAPI_ACCESS_TOKEN: 'wa-token-SECRET',
      META_TEST_EVENT_CODE: 'TEST12345',
      META_HTTP_TIMEOUT_MS: '5000',
    });

    const payload = {
      data: [
        {
          event_name: 'LeadSubmitted',
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
        },
      ],
    };

    expect(meta.resolveGraphCredentialLane(payload, 'LeadSubmitted')).toBe(
      'whatsapp_messaging',
    );

    const send = await meta.sendToMeta('4419657838288963', payload, {
      eventName: 'LeadSubmitted',
    });
    expect(send.ok).toBe(true);
    expect(authHeaders).toEqual(['Bearer wa-token-SECRET']);
    expect(authHeaders[0]).not.toContain('web-token');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      'graph.facebook.com/v26.0/4419657838288963/events',
    );
  });

  it('website Lead POSTea con Bearer web y META_API_VERSION', async () => {
    const authHeaders: string[] = [];
    global.fetch = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        authHeaders.push(String(headers?.Authorization || ''));
        return {
          ok: true,
          status: 200,
          json: async () => ({ events_received: 1, fbtrace_id: 'WEB_MOCK' }),
        } as Response;
      },
    ) as typeof fetch;

    const meta = makeMeta({
      META_MODE: 'test',
      META_DATASET_ID: 'dataset-web',
      META_API_VERSION: 'v21.0',
      META_CAPI_ACCESS_TOKEN: 'web-token-SECRET',
      META_WA_CAPI_ACCESS_TOKEN: 'wa-token-SECRET',
      META_TEST_EVENT_CODE: 'TEST12345',
      META_HTTP_TIMEOUT_MS: '5000',
    });

    const payload = {
      data: [{ event_name: 'Lead', action_source: 'website' }],
    };
    const send = await meta.sendToMeta('dataset-web', payload, {
      eventName: 'Lead',
    });
    expect(send.ok).toBe(true);
    expect(authHeaders).toEqual(['Bearer web-token-SECRET']);
  });

  it('BM sin META_WA_CAPI_ACCESS_TOKEN falla sin usar token web', async () => {
    global.fetch = jest.fn() as typeof fetch;
    const meta = makeMeta({
      META_MODE: 'live',
      META_DATASET_ID: 'dataset-web',
      META_API_VERSION: 'v21.0',
      META_CAPI_ACCESS_TOKEN: 'web-token-SECRET',
      META_HTTP_TIMEOUT_MS: '5000',
    });

    const send = await meta.sendToMeta(
      '4419657838288963',
      {
        data: [
          {
            event_name: 'LeadSubmitted',
            action_source: 'business_messaging',
          },
        ],
      },
      { eventName: 'LeadSubmitted' },
    );
    expect(send.ok).toBe(false);
    expect(send.errorMessage).toBe('Falta META_WA_CAPI_ACCESS_TOKEN');
    expect(
      meta.assertSendAllowedFor(
        {
          data: [
            {
              event_name: 'LeadSubmitted',
              action_source: 'business_messaging',
            },
          ],
        },
        'LeadSubmitted',
      ),
    ).toEqual({ ok: false, reason: 'Falta META_WA_CAPI_ACCESS_TOKEN' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

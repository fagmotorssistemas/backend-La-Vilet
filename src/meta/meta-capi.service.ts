import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildHashedUserData,
  newEventId,
  type MatchInput,
} from '../common/utils/hash';
import { isMetaSendSuccess } from './meta-success';
import {
  applyCoreSetupConservativeToGraphBody,
  isCoreSetupConservativeEnabled,
  originOnlyEventSourceUrl,
} from './core-setup-conservative';

export type MetaMode = 'disabled' | 'test' | 'live';
export type MetaEventName = 'ViewContent' | 'Lead' | 'Schedule';

export type BuildGraphInput = {
  eventName: MetaEventName;
  eventId?: string;
  eventTime?: number;
  actionSource:
    'website' | 'system_generated' | 'business_messaging' | 'other' | 'chat';
  eventSourceUrl?: string | null;
  match?: MatchInput;
  fbp?: string | null;
  fbc?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  contentIds?: string[];
  contentName?: string | null;
  contentCategory?: string | null;
  messagingChannel?: 'whatsapp';
  ctwaClid?: string | null;
};

@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name);

  constructor(private readonly config: ConfigService) {}

  get mode(): MetaMode {
    const raw = String(this.config.get<string>('META_MODE') || 'disabled')
      .trim()
      .toLowerCase();
    if (raw === 'test' || raw === 'live' || raw === 'disabled') return raw;
    return 'disabled';
  }

  get datasetId(): string {
    return (
      this.config.get<string>('META_DATASET_ID')?.trim() ||
      this.config.get<string>('META_PIXEL_ID')?.trim() ||
      '923439043758658'
    );
  }

  get apiVersion(): string {
    return this.config.get<string>('META_API_VERSION')?.trim() || 'v21.0';
  }

  get accessToken(): string {
    return String(
      this.config.get<string>('META_CAPI_ACCESS_TOKEN') || '',
    ).trim();
  }

  get testEventCode(): string | null {
    const code = String(
      this.config.get<string>('META_TEST_EVENT_CODE') || '',
    ).trim();
    return code || null;
  }

  /** Core Setup / configuración básica: sin custom_data; URL solo origen. */
  get coreSetupConservative(): boolean {
    return isCoreSetupConservativeEnabled(
      this.config.get<string>('META_CORE_SETUP_CONSERVATIVE'),
    );
  }

  /**
   * Reglas de activación:
   * - disabled: no envía
   * - test: requiere token + test code
   * - live: requiere token y PROHÍBE test code activo
   */
  assertSendAllowed(): { ok: true } | { ok: false; reason: string } {
    const mode = this.mode;
    if (mode === 'disabled') {
      return { ok: false, reason: 'META_MODE=disabled' };
    }
    if (!this.accessToken) {
      return { ok: false, reason: 'Falta META_CAPI_ACCESS_TOKEN' };
    }
    if (mode === 'live' && this.testEventCode) {
      return {
        ok: false,
        reason:
          'META_MODE=live bloqueado mientras META_TEST_EVENT_CODE esté definido. Quítalo para producción.',
      };
    }
    if (mode === 'test' && !this.testEventCode) {
      return {
        ok: false,
        reason: 'META_MODE=test requiere META_TEST_EVENT_CODE',
      };
    }
    return { ok: true };
  }

  sanitizeEventSourceUrl(raw?: string | null): string | undefined {
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      if (/^\/simulador(?:\/|$)/i.test(url.pathname)) {
        return undefined;
      }
      if (this.coreSetupConservative) {
        return originOnlyEventSourceUrl(url.toString());
      }
      url.search = '';
      url.hash = '';
      if (/@|\d{8,}/.test(url.pathname)) {
        url.pathname = '/';
      }
      return url.toString();
    } catch {
      return undefined;
    }
  }

  /**
   * Revalida reglas Core Setup sobre un body Graph ya persistido (cola antigua).
   * Idempotente; no toca Meta.
   */
  applyCoreSetupBeforeGraphSend(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.coreSetupConservative) return body;
    return applyCoreSetupConservativeToGraphBody(body);
  }

  buildFbc(fbclid?: string | null, existingFbc?: string | null): string | null {
    if (existingFbc && /^fb\.\d+\.\d+\./.test(existingFbc)) return existingFbc;
    if (!fbclid || !String(fbclid).trim()) return null;
    return `fb.1.${Date.now()}.${String(fbclid).trim()}`;
  }

  buildGraphPayload(input: BuildGraphInput): {
    eventId: string;
    eventTime: number;
    payload: Record<string, unknown>;
    redacted: Record<string, unknown>;
  } {
    const eventId = input.eventId || newEventId();
    const eventTime = input.eventTime || Math.floor(Date.now() / 1000);

    const userData: Record<string, unknown> = {
      ...buildHashedUserData(input.match || {}),
    };
    if (input.fbp) userData.fbp = input.fbp;
    if (input.fbc) userData.fbc = input.fbc;
    if (input.clientIpAddress)
      userData.client_ip_address = input.clientIpAddress;
    if (input.clientUserAgent)
      userData.client_user_agent = input.clientUserAgent;

    const event: Record<string, unknown> = {
      event_name: input.eventName,
      event_time: eventTime,
      event_id: eventId,
      action_source: input.actionSource,
      user_data: userData,
    };

    if (input.actionSource === 'website') {
      const url = this.sanitizeEventSourceUrl(input.eventSourceUrl);
      if (url) event.event_source_url = url;
    }

    if (input.actionSource === 'business_messaging') {
      event.messaging_channel = input.messagingChannel || 'whatsapp';
    }

    const conservative = this.coreSetupConservative;
    if (!conservative) {
      const custom: Record<string, unknown> = {};
      if (input.contentIds?.length) custom.content_ids = input.contentIds;
      if (input.contentName) custom.content_name = input.contentName;
      if (input.contentCategory) custom.content_category = input.contentCategory;
      if (input.ctwaClid) custom.ctwa_clid = input.ctwaClid;
      // Sin value/currency artificial; sin content_type inventado
      if (Object.keys(custom).length) event.custom_data = custom;
    }

    let payload: Record<string, unknown> = { data: [event] };
    if (this.mode === 'test' && this.testEventCode) {
      payload.test_event_code = this.testEventCode;
    }
    if (conservative) {
      payload = applyCoreSetupConservativeToGraphBody(payload);
    }

    const redacted = {
      event_name: input.eventName,
      event_id: eventId,
      event_time: eventTime,
      action_source: input.actionSource,
      has_em: Boolean((userData as { em?: unknown }).em),
      has_ph: Boolean((userData as { ph?: unknown }).ph),
      has_fn: Boolean((userData as { fn?: unknown }).fn),
      has_ln: Boolean((userData as { ln?: unknown }).ln),
      has_ct: Boolean((userData as { ct?: unknown }).ct),
      has_country: Boolean((userData as { country?: unknown }).country),
      has_external_id: Boolean(
        (userData as { external_id?: unknown }).external_id,
      ),
      has_client_ip: Boolean(input.clientIpAddress),
      has_client_ua: Boolean(input.clientUserAgent),
      has_fbp: Boolean(input.fbp),
      has_fbc: Boolean(input.fbc),
      content_ids: conservative ? null : input.contentIds || null,
      content_name: conservative ? null : input.contentName || null,
      content_category: conservative ? null : input.contentCategory || null,
      core_setup_conservative: conservative,
      test_mode: this.mode === 'test',
    };

    return { eventId, eventTime, payload, redacted };
  }

  async sendToMeta(
    datasetId: string,
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    httpStatus: number;
    eventsReceived: number | null;
    fbtraceId: string | null;
    retryable: boolean;
    errorMessage: string | null;
    bodyRedacted: Record<string, unknown>;
  }> {
    const timeout = Number(this.config.get('META_HTTP_TIMEOUT_MS')) || 10000;
    const url = `https://graph.facebook.com/${this.apiVersion}/${datasetId}/events`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const error = body.error as Record<string, unknown> | undefined;
      const eventsReceived =
        typeof body.events_received === 'number' ? body.events_received : null;
      const ok = isMetaSendSuccess({
        httpOk: response.ok,
        error,
        eventsReceived,
      });

      const errorCode = typeof error?.code === 'number' ? error.code : null;
      const retryable =
        !ok &&
        (response.status === 429 ||
          response.status >= 500 ||
          (errorCode !== null && [1, 2, 4, 17].includes(errorCode)));

      const errorMessageText =
        typeof error?.message === 'string'
          ? error.message
          : typeof error?.type === 'string'
            ? error.type
            : 'meta_error';

      if (!ok) {
        this.logger.warn(
          `Meta reject http=${response.status} code=${String(errorCode ?? '')} events_received=${String(eventsReceived)}`,
        );
      }

      return {
        ok,
        httpStatus: response.status,
        eventsReceived,
        fbtraceId: typeof body.fbtrace_id === 'string' ? body.fbtrace_id : null,
        retryable,
        errorMessage: error
          ? errorMessageText
          : ok
            ? null
            : `events_received=${String(eventsReceived)}`,
        bodyRedacted: {
          http_status: response.status,
          events_received: eventsReceived,
          fbtrace_id: body.fbtrace_id ?? null,
          error_code: errorCode,
          error_type: typeof error?.type === 'string' ? error.type : null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'fetch_failed';
      this.logger.warn(`Meta network error: ${message}`);
      return {
        ok: false,
        httpStatus: 0,
        eventsReceived: null,
        fbtraceId: null,
        retryable: true,
        errorMessage: message.slice(0, 200),
        bodyRedacted: { network_error: true },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

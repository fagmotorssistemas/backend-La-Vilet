import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import {
  isLikelyArtificialEmail,
  isLikelyArtificialName,
} from '../common/utils/phone';
import type {
  EnqueueEventDto,
  MetaEnqueueEventName,
} from './dto/enqueue-event.dto';
import { evaluateMetaAcceptanceEvidence } from '../meta/meta-acceptance';
import {
  gateAddToWishlist,
  gateHomeListingContent,
  gateInitiateCheckout,
  gateQualifiedPurchase,
  gateSale,
  gateSearch,
  gateViewContent,
  normalizeCurrency,
  resolveHomeListingContent,
  validQualifiedPurchaseValue,
} from '../meta/measurement-event-gates';
import { EVENT_TIME_TOO_OLD, isEventTimeTooOld } from '../meta/event-age';

export type NestEventLookupResponse = {
  ok: true;
  found: true;
  event_id: string;
  event_name: string;
  /** Estado SQLite Nest (pending|processing|sent|failed|dead|cancelled). */
  status: string;
  attempt_count: number;
  last_error: string | null;
  delivery_lane: string;
  dataset_id: string;
  sent_at: string | null;
  updated_at: string;
  created_at: string;
  /** Evidencia Graph redacted si existe (solo tras markSent tipicamente). */
  meta_response: {
    http_status: number | null;
    events_received: number | null;
    fbtrace_id: string | null;
    error_code: string | number | null;
    error_type: string | null;
  } | null;
  /**
   * Derivado de status + meta_response. No inventa aceptación:
   * - api_accepted solo si status=sent y evidencia Graph coherente
   * - api_rejected si dead/failed con error o meta_response rechazada
   * - insufficient_evidence / unknown en el resto
   */
  acceptance_tier:
    'api_accepted' | 'api_rejected' | 'insufficient_evidence' | 'unknown';
  /** Alias explícito para el CRM: true solo con api_accepted. */
  api_accepted: boolean;
  /** Estado operativo, separado de la evidencia Graph. */
  delivery_outcome:
    | 'backend_accepted'
    | 'transport_failed'
    | 'meta_rejected'
    | 'meta_unverified'
    | 'meta_accepted'
    | 'cancelled';
};

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly meta: MetaCapiService,
  ) {}

  /**
   * Lookup de trazabilidad por event_id (solo lectura SQLite).
   * No reenvía ni marca históricos como aceptados sin evidencia.
   */
  lookupByEventId(eventId: string): NestEventLookupResponse {
    const id = String(eventId || '').trim();
    if (!id) throw new BadRequestException('event_id_required');
    try {
      const row = this.db.getLatestByEventId(id);
      if (!row) {
        // Contrato explícito para CRM/FE: ausente ≠ rechazo Meta.
        throw new NotFoundException({
          ok: false,
          found: false,
          error: 'event_not_found',
          event_id: id,
        });
      }

      let metaResponse: NestEventLookupResponse['meta_response'] = null;
      if (row.meta_response_redacted) {
        try {
          const parsed = JSON.parse(row.meta_response_redacted) as Record<
            string,
            unknown
          >;
          metaResponse = {
            http_status:
              typeof parsed.http_status === 'number'
                ? parsed.http_status
                : null,
            events_received:
              typeof parsed.events_received === 'number'
                ? parsed.events_received
                : null,
            fbtrace_id:
              typeof parsed.fbtrace_id === 'string' ? parsed.fbtrace_id : null,
            error_code:
              parsed.error_code != null
                ? (parsed.error_code as string | number)
                : null,
            error_type:
              typeof parsed.error_type === 'string' ? parsed.error_type : null,
          };
        } catch {
          metaResponse = null;
        }
      }

      let acceptance_tier: NestEventLookupResponse['acceptance_tier'] =
        'unknown';
      if (row.status === 'sent' && metaResponse) {
        const httpStatus = metaResponse.http_status ?? 0;
        const evidence = evaluateMetaAcceptanceEvidence({
          httpOk: httpStatus >= 200 && httpStatus < 300,
          httpStatus,
          error: metaResponse.error_code
            ? { code: metaResponse.error_code }
            : undefined,
          eventsReceived: metaResponse.events_received,
          expectedEvents: 1,
          eventId: row.event_id,
          fbtraceId: metaResponse.fbtrace_id,
        });
        acceptance_tier = evidence.tier;
      } else if (row.delivery_outcome === 'meta_rejected') {
        acceptance_tier = 'api_rejected';
      } else if (
        row.delivery_outcome === 'transport_failed' ||
        row.delivery_outcome === 'meta_unverified'
      ) {
        acceptance_tier = 'insufficient_evidence';
      } else if (row.status === 'sent' && !metaResponse) {
        acceptance_tier = 'insufficient_evidence';
      }

      return {
        ok: true,
        found: true,
        event_id: row.event_id,
        event_name: row.event_name,
        status: row.status,
        attempt_count: row.attempt_count,
        last_error: row.last_error,
        delivery_lane: row.delivery_lane,
        dataset_id: row.dataset_id,
        sent_at: row.sent_at,
        updated_at: row.updated_at,
        created_at: row.created_at,
        meta_response: metaResponse,
        acceptance_tier,
        api_accepted: acceptance_tier === 'api_accepted',
        delivery_outcome: normalizeDeliveryOutcome(row),
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      // Transitorio/interno: nunca inventar aceptación o rechazo Meta.
      throw new InternalServerErrorException({
        ok: false,
        found: false,
        error: 'lookup_internal_error',
        event_id: id,
      });
    }
  }

  enqueue(dto: EnqueueEventDto) {
    return this.enqueueEvent(dto, null);
  }

  /**
   * Encola un evento. `cascadeFrom` solo lo usa la cascada interna: marca el
   * linaje y evita cascadas recursivas.
   */
  private enqueueEvent(
    dto: EnqueueEventDto,
    cascadeFrom: { eventId: string; eventName: string } | null,
  ): EnqueueResponse {
    if (!dto.ads_consent) {
      throw new BadRequestException('ads_consent requerido y debe ser true');
    }

    // Meta rechazaría la petición entera: no se encola un evento ya vencido.
    if (
      this.meta.eventMaxAgeCheckEnabled &&
      dto.event_time != null &&
      isEventTimeTooOld(dto.event_time)
    ) {
      throw new BadRequestException(EVENT_TIME_TOO_OLD);
    }

    if (
      dto.event_name === 'LeadSubmitted' ||
      dto.event_name === 'QualifiedLead'
    ) {
      if (dto.action_source !== 'business_messaging') {
        throw new BadRequestException(
          dto.event_name === 'LeadSubmitted'
            ? 'lead_submitted_requires_business_messaging'
            : 'qualified_lead_requires_business_messaging',
        );
      }
      if (dto.messaging_channel !== 'whatsapp') {
        throw new BadRequestException(
          dto.event_name === 'LeadSubmitted'
            ? 'lead_submitted_requires_whatsapp_channel'
            : 'qualified_lead_requires_whatsapp_channel',
        );
      }
    }

    if (dto.action_source === 'business_messaging') {
      // Schedule WhatsApp: Meta BM no admite event_name Schedule (docs CAPI BM;
      // Graph 2804066). No renombrar ni remapear a website.
      if (dto.event_name === 'Schedule') {
        throw new BadRequestException(
          'business_messaging_schedule_not_supported_by_meta',
        );
      }
      if (!BUSINESS_MESSAGING_EVENTS.has(dto.event_name)) {
        throw new BadRequestException('business_messaging_event_not_supported');
      }
      if (dto.messaging_channel !== 'whatsapp') {
        throw new BadRequestException(
          'business_messaging_requires_whatsapp_channel',
        );
      }
      const dataset = String(dto.messaging_dataset_id || '').trim();
      const ctwa = String(dto.ctwa_clid || '').trim();
      const waba = String(dto.whatsapp_business_account_id || '').trim();
      if (!dataset || !ctwa || !waba) {
        throw new BadRequestException(
          'business_messaging_identifiers_required',
        );
      }
      // Nunca usar dataset web/pixel como fallback; WABA ≠ dataset Graph.
      if (dataset === waba) {
        throw new BadRequestException(
          'business_messaging_waba_must_not_equal_dataset',
        );
      }
      if (dataset === this.meta.datasetId) {
        throw new BadRequestException(
          'business_messaging_dataset_must_not_be_web_pixel',
        );
      }
      if (!this.meta.messagingDatasetId || !this.meta.wabaId) {
        throw new BadRequestException(
          'business_messaging_destination_not_configured',
        );
      }
      if (dataset !== this.meta.messagingDatasetId) {
        throw new BadRequestException(
          'business_messaging_dataset_destination_mismatch',
        );
      }
      if (waba !== this.meta.wabaId) {
        throw new BadRequestException('business_messaging_waba_mismatch');
      }
    }

    if (dto.event_name === 'QualifiedLead') {
      if (
        !dto.lead_id ||
        !dto.tenant_id ||
        !dto.project_id ||
        !dto.contact_id
      ) {
        throw new BadRequestException('qualified_lead_scope_required');
      }
      if (!dto.temperature) {
        throw new BadRequestException('qualified_lead_level_required');
      }
      if (!dto.evidence_labels?.length) {
        throw new BadRequestException('qualified_lead_reasons_required');
      }
      if (dto.qualification_source !== 'crm_persisted_evaluation') {
        throw new BadRequestException('qualified_lead_source_required');
      }
      if (dto.idempotency_key !== `wa_crm_qualified:${dto.lead_id}`) {
        throw new BadRequestException('qualified_lead_idempotency_key_invalid');
      }
    }

    const subtype = String(dto.lv_internal_subtype || '').trim() || null;
    const unitId = String(dto.unit_id || '').trim() || null;
    const saleId = String(dto.sale_id || '').trim() || null;
    const leadId = dto.lead_id || dto.external_id || null;

    const homeListing = resolveHomeListingContent({
      subtype,
      unitId,
      contentIds: dto.content_ids,
      contentType: dto.content_type,
      eventName: dto.event_name,
    });
    const contentIds = homeListing.contentIds;
    const contentType = homeListing.contentType;

    const homeListingGate = gateHomeListingContent({
      contentType,
      contentIds,
      unitId,
      eventName: dto.event_name,
    });
    if (!homeListingGate.ok) {
      throw new BadRequestException(homeListingGate.reason);
    }

    const eventGate = this.gateForEvent(dto, {
      subtype,
      unitId,
      saleId,
      leadId,
      contentIds,
    });
    if (!eventGate.ok) throw new BadRequestException(eventGate.reason);

    // Valor en custom_data: Purchase lleva el precio real de la unidad que
    // resolvió el CRM; sin precio válido, el worker aplica al enviar el valor de
    // respaldo (META_QUALIFIED_PURCHASE_VALUE). VentaCerrada, el importe real.
    let eventValue: number | null = null;
    let eventCurrency: string | null = null;
    if (dto.event_name === 'Purchase') {
      eventValue = validQualifiedPurchaseValue(dto.value);
      eventCurrency =
        eventValue != null
          ? normalizeCurrency(dto.currency) ||
            this.meta.qualifiedPurchaseCurrency
          : null;
    } else if (dto.event_name === 'VentaCerrada') {
      eventValue = saleValueFrom(dto);
      eventCurrency = normalizeCurrency(dto.currency);
    }

    const visitorKey = dto.visitor_key || null;

    const email = isLikelyArtificialEmail(dto.email) ? undefined : dto.email;
    const firstName = isLikelyArtificialName(dto.first_name)
      ? undefined
      : dto.first_name;
    const lastName = isLikelyArtificialName(dto.last_name)
      ? undefined
      : dto.last_name;
    const fullName = isLikelyArtificialName(dto.full_name)
      ? undefined
      : dto.full_name;

    if (dto.action_source !== 'website') {
      dto.client_ip_address = undefined;
      dto.client_user_agent = undefined;
      dto.event_source_url = undefined;
      dto.fbp = undefined;
      dto.fbc = undefined;
      dto.fbclid = undefined;
    }

    const fbc = this.meta.buildFbc(dto.fbclid, dto.fbc);

    const built = this.meta.buildGraphPayload({
      eventName: dto.event_name,
      eventId: dto.event_id,
      eventTime: dto.event_time,
      actionSource: dto.action_source,
      eventSourceUrl: dto.event_source_url,
      match: {
        phone: dto.phone,
        email,
        firstName,
        lastName,
        fullName,
        city: dto.city,
        country: dto.country,
        externalId: dto.external_id || leadId || undefined,
      },
      fbp: dto.fbp,
      fbc,
      clientIpAddress: dto.client_ip_address,
      clientUserAgent: dto.client_user_agent,
      contentIds,
      contentType,
      contentName: dto.content_name,
      contentCategory: dto.content_category,
      value: eventValue,
      currency: eventCurrency,
      messagingChannel:
        dto.messaging_channel === 'whatsapp' ? 'whatsapp' : undefined,
      ctwaClid: dto.ctwa_clid,
      whatsappBusinessAccountId: dto.whatsapp_business_account_id,
      messagingDatasetId: dto.messaging_dataset_id,
    });

    const deliveryLane =
      dto.delivery_lane || (this.meta.mode === 'test' ? 'test' : 'live');
    if (
      (this.meta.mode === 'live' || this.meta.mode === 'test') &&
      deliveryLane !== this.meta.mode
    ) {
      throw new BadRequestException('delivery_lane_mismatch');
    }

    let datasetForRow: string;
    if (dto.action_source === 'business_messaging') {
      datasetForRow = String(dto.messaging_dataset_id).trim();
    } else {
      datasetForRow = this.meta.datasetId;
    }

    const result = this.db.insertOutbox({
      idempotency_key: dto.idempotency_key,
      event_id: built.eventId,
      event_name: dto.event_name,
      event_time: built.eventTime,
      payload_redacted: {
        ...built.redacted,
        tenant_id: dto.tenant_id || null,
        project_id: dto.project_id || null,
        contact_id: dto.contact_id || null,
        lead_id: leadId,
        lv_internal_subtype: subtype,
        unit_id: unitId,
        sale_id: saleId,
        sale_at: String(dto.sale_at || '').trim() || null,
        registered_at: String(dto.registered_at || '').trim() || null,
        temperature: dto.temperature || null,
        evidence_labels: dto.evidence_labels || null,
        qualification_source: dto.qualification_source || null,
        initial_lead_submitted_event_id:
          dto.initial_lead_submitted_event_id || null,
        cascade_from_event_id: cascadeFrom?.eventId ?? null,
        cascade_from_event_name: cascadeFrom?.eventName ?? null,
      },
      graph_payload: built.payload,
      dataset_id: datasetForRow,
      delivery_lane: deliveryLane,
      visitor_key: visitorKey,
      lead_id: leadId,
      ads_consent_required: true,
    });

    if (!result.inserted) {
      const conflicts =
        result.row.event_name !== dto.event_name ||
        result.row.delivery_lane !== deliveryLane ||
        (dto.event_id != null && result.row.event_id !== dto.event_id) ||
        (dto.event_time != null && result.row.event_time !== dto.event_time) ||
        result.row.dataset_id !== datasetForRow ||
        storedPayloadConflicts(result.row.payload_redacted, dto, {
          leadId,
          unitId,
          saleId,
          eventValue,
          eventCurrency,
        });
      if (conflicts) {
        throw new ConflictException('idempotency_key_conflict');
      }
    }

    const sendGate = this.meta.assertSendAllowedFor(
      built.payload,
      dto.event_name,
    );
    const holdReason = this.deliveryHoldReason(
      dto.event_name,
      dto.action_source,
      eventValue != null,
    );

    let delivery: string;
    if (result.blocked_by_consent || result.row.status === 'cancelled') {
      delivery = 'cancelled:ads_consent_revoked';
    } else if (!sendGate.ok) {
      delivery = `held:${sendGate.reason}`;
    } else if (holdReason) {
      delivery = `held:${holdReason}`;
    } else {
      delivery = 'queued';
    }

    const cascade =
      cascadeFrom === null &&
      result.inserted &&
      !result.blocked_by_consent &&
      result.row.status !== 'cancelled'
        ? this.cascadeLowerEvents(dto, {
            eventId: built.eventId,
            eventTime: built.eventTime,
            leadId,
            visitorKey,
            unitId,
          })
        : [];

    return {
      ok: true,
      accepted: result.inserted,
      duplicate: !result.inserted,
      blocked_by_consent: Boolean(result.blocked_by_consent),
      event_id: result.row.event_id,
      event_name: result.row.event_name,
      event_time: result.row.event_time,
      outbox_status: result.row.status,
      delivery_lane: result.row.delivery_lane,
      mode: this.meta.mode,
      delivery,
      dataset_id: datasetForRow,
      delivery_outcome: normalizeDeliveryOutcome(result.row),
      cascade,
    };
  }

  private gateForEvent(
    dto: EnqueueEventDto,
    ctx: {
      subtype: string | null;
      unitId: string | null;
      saleId: string | null;
      leadId: string | null;
      contentIds: string[] | undefined;
    },
  ): { ok: true } | { ok: false; reason: string } {
    switch (dto.event_name) {
      case 'ViewContent':
        return gateViewContent({
          subtype: ctx.subtype,
          unitId: ctx.unitId,
          contentIds: ctx.contentIds,
        });
      case 'Search':
        return gateSearch({
          actionSource: dto.action_source,
          contentIds: ctx.contentIds,
        });
      case 'InitiateCheckout':
        return gateInitiateCheckout({
          actionSource: dto.action_source,
          unitId: ctx.unitId,
        });
      case 'AddToWishlist':
        return gateAddToWishlist({
          actionSource: dto.action_source,
          leadId: ctx.leadId,
          unitId: ctx.unitId,
        });
      case 'Purchase':
        return gateQualifiedPurchase({
          actionSource: dto.action_source,
          leadId: ctx.leadId,
        });
      case 'VentaCerrada':
        return gateSale({
          actionSource: dto.action_source,
          saleId: ctx.saleId,
          leadId: ctx.leadId,
          unitId: ctx.unitId,
          value: saleValueFrom(dto),
          currency: normalizeCurrency(dto.currency),
        });
      default:
        return { ok: true };
    }
  }

  /** Motivo por el que un evento aceptado queda retenido (interruptor apagado). */
  private deliveryHoldReason(
    eventName: string,
    actionSource: string,
    hasOwnValue = false,
  ): string | null {
    // Mismas reglas que delivery-flags.ts (worker y drain).
    if (eventName === 'Schedule' && !this.meta.scheduleDeliveryEnabled) {
      return 'schedule_delivery_inactive';
    }
    if (
      eventName === 'LeadSubmitted' &&
      !this.meta.waLeadSubmittedDeliveryEnabled
    ) {
      return 'wa_lead_submitted_delivery_inactive';
    }
    if (
      eventName === 'QualifiedLead' &&
      !this.meta.waCrmQualificationDeliveryEnabled
    ) {
      return 'wa_crm_qualification_delivery_inactive';
    }
    if (eventName === 'Purchase') {
      if (!this.meta.qualifiedPurchaseDeliveryEnabled) {
        return 'qualified_purchase_delivery_inactive';
      }
      if (!hasOwnValue && this.meta.qualifiedPurchaseValue == null) {
        return 'qualified_purchase_value_not_configured';
      }
    }
    if (eventName === 'VentaCerrada' && !this.meta.saleDeliveryEnabled) {
      return 'sale_delivery_inactive';
    }
    if (
      isFunnelEvent(eventName, actionSource) &&
      !this.meta.funnelEventsDeliveryEnabled
    ) {
      return 'funnel_events_delivery_inactive';
    }
    return null;
  }

  /**
   * Cascada: un evento alto implica los inferiores (quien es contacto calificado
   * por una unidad también mostró interés, la vio y es lead). Encola los que
   * falten, en el mismo canal, sin duplicar: Lead/LeadSubmitted una vez por
   * lead; ViewContent/InitiateCheckout una vez por persona y unidad cada 24 h.
   * Un fallo en la cascada nunca invalida el evento principal.
   */
  private cascadeLowerEvents(
    dto: EnqueueEventDto,
    primary: {
      eventId: string;
      eventTime: number;
      leadId: string | null;
      visitorKey: string | null;
      unitId: string | null;
    },
  ): CascadeResult[] {
    if (!this.meta.signalCascadeEnabled) return [];
    const targets = cascadeTargets(
      dto.event_name,
      dto.action_source,
      primary.unitId,
    );
    const results: CascadeResult[] = [];
    for (const target of targets) {
      const sinceHours =
        target === 'Lead' || target === 'LeadSubmitted' ? null : 24;
      if (
        this.db.hasRecentEventForScope({
          eventName: target,
          leadId: primary.leadId,
          visitorKey: primary.visitorKey,
          unitId:
            target === 'Lead' || target === 'LeadSubmitted'
              ? null
              : primary.unitId,
          sinceHours,
        })
      ) {
        results.push({ event_name: target, delivery: 'skipped:already_sent' });
        continue;
      }
      const child: EnqueueEventDto = {
        ...dto,
        event_name: target,
        idempotency_key: `cascade:${target}:${dto.idempotency_key}`.slice(
          0,
          200,
        ),
        event_id: deterministicUuidV4(`cascade:${primary.eventId}:${target}`),
        event_time: primary.eventTime,
        lv_internal_subtype:
          target === 'ViewContent' && primary.unitId
            ? 'detalle_unidad'
            : undefined,
        content_ids: primary.unitId ? [primary.unitId] : undefined,
        content_type: primary.unitId ? 'home_listing' : undefined,
        value: undefined,
        currency: undefined,
        sale_id: undefined,
        sale_at: undefined,
        registered_at: undefined,
        temperature: undefined,
        evidence_labels: undefined,
        qualification_source: undefined,
      };
      try {
        const response = this.enqueueEvent(child, {
          eventId: primary.eventId,
          eventName: dto.event_name,
        });
        results.push({
          event_name: target,
          event_id: response.event_id,
          delivery: response.duplicate ? 'duplicate' : response.delivery,
        });
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message.slice(0, 120)
            : 'cascade_error';
        this.logger.warn(
          `cascade skip ${target} from=${dto.event_name} reason=${reason}`,
        );
        results.push({ event_name: target, delivery: `rejected:${reason}` });
      }
    }
    return results;
  }
}

type CascadeResult = {
  event_name: string;
  event_id?: string;
  delivery: string;
};

type EnqueueResponse = {
  ok: true;
  accepted: boolean;
  duplicate: boolean;
  blocked_by_consent: boolean;
  event_id: string;
  event_name: string;
  event_time: number;
  outbox_status: string;
  delivery_lane: string;
  mode: string;
  delivery: string;
  dataset_id: string;
  delivery_outcome: NestEventLookupResponse['delivery_outcome'];
  cascade: CascadeResult[];
};

/** Eventos que Meta admite por CAPI Business Messaging (WhatsApp). */
const BUSINESS_MESSAGING_EVENTS = new Set([
  'LeadSubmitted',
  'QualifiedLead',
  'Purchase',
  'InitiateCheckout',
  'ViewContent',
]);

/** Eventos de embudo nuevos, retenidos hasta META_FUNNEL_EVENTS_DELIVERY_ENABLED. */
export function isFunnelEvent(eventName: string, actionSource: string) {
  return (
    eventName === 'Search' ||
    eventName === 'InitiateCheckout' ||
    (eventName === 'ViewContent' && actionSource === 'business_messaging')
  );
}

/** Eventos inferiores implicados por uno superior (mismo canal). */
export function cascadeTargets(
  eventName: string,
  actionSource: string,
  unitId: string | null,
): MetaEnqueueEventName[] {
  const lead: MetaEnqueueEventName =
    actionSource === 'business_messaging' ? 'LeadSubmitted' : 'Lead';
  if (eventName === 'Purchase') {
    return unitId ? ['InitiateCheckout', 'ViewContent', lead] : [lead];
  }
  if (eventName === 'InitiateCheckout' && unitId) {
    return ['ViewContent'];
  }
  return [];
}

function saleValueFrom(dto: EnqueueEventDto): number | null {
  return dto.value != null && Number.isFinite(Number(dto.value))
    ? Number(dto.value)
    : null;
}

/** UUID con formato v4 estable a partir de una semilla (reintentos idempotentes). */
export function deterministicUuidV4(seed: string): string {
  const hex = createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const v = hex.join('');
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

/**
 * Un reintento con la misma clave debe describir el mismo hecho. Compara los
 * campos que cambian su significado. En Purchase no se compara el valor: lo
 * resuelve el CRM (precio de la unidad) y puede variar entre reintentos; manda
 * el primero que se encoló.
 */
function storedPayloadConflicts(
  storedJson: string,
  dto: EnqueueEventDto,
  current: {
    leadId: string | null;
    unitId: string | null;
    saleId: string | null;
    eventValue: number | null;
    eventCurrency: string | null;
  },
): boolean {
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(storedJson) as Record<string, unknown>;
  } catch {
    return true;
  }
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  if (dto.event_name === 'QualifiedLead') {
    return (
      stored.temperature !== dto.temperature ||
      JSON.stringify(stored.evidence_labels || []) !==
        JSON.stringify(dto.evidence_labels || []) ||
      !same(stored.qualification_source, dto.qualification_source)
    );
  }
  if (dto.event_name === 'Purchase') {
    return (
      !same(stored.lead_id, current.leadId) ||
      !same(stored.unit_id, current.unitId)
    );
  }
  if (dto.event_name === 'VentaCerrada') {
    return (
      !same(stored.sale_id, current.saleId) ||
      !same(stored.lead_id, current.leadId) ||
      !same(stored.unit_id, current.unitId) ||
      !same(stored.value, current.eventValue) ||
      !same(stored.currency, current.eventCurrency)
    );
  }
  return false;
}

function normalizeDeliveryOutcome(row: {
  status: string;
  delivery_outcome?: string | null;
}): NestEventLookupResponse['delivery_outcome'] {
  if (row.status === 'cancelled') return 'cancelled';
  const value = String(row.delivery_outcome || '').trim();
  if (
    value === 'transport_failed' ||
    value === 'meta_rejected' ||
    value === 'meta_unverified' ||
    value === 'meta_accepted'
  ) {
    return value;
  }
  return 'backend_accepted';
}

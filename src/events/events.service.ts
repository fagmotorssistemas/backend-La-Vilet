import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import {
  isLikelyArtificialEmail,
  isLikelyArtificialName,
} from '../common/utils/phone';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';
import { evaluateMetaAcceptanceEvidence } from '../meta/meta-acceptance';
import {
  gateAddToWishlist,
  gatePurchase,
  gateViewContent,
  normalizeCurrency,
  resolveViewContentContentIds,
} from '../meta/measurement-event-gates';

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
    if (!dto.ads_consent) {
      throw new BadRequestException('ads_consent requerido y debe ser true');
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
      if (!['LeadSubmitted', 'QualifiedLead'].includes(dto.event_name)) {
        throw new BadRequestException('business_messaging_lead_submitted_only');
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

    if (dto.event_name === 'ViewContent') {
      const gate = gateViewContent({
        subtype,
        unitId,
        contentIds: dto.content_ids,
      });
      if (!gate.ok) throw new BadRequestException(gate.reason);
    }

    if (dto.event_name === 'AddToWishlist') {
      const gate = gateAddToWishlist({
        actionSource: dto.action_source,
        leadId,
        unitId,
      });
      if (!gate.ok) throw new BadRequestException(gate.reason);
    }

    let purchaseCurrency: string | null = null;
    let purchaseValue: number | null = null;
    if (dto.event_name === 'Purchase') {
      purchaseCurrency = normalizeCurrency(dto.currency);
      purchaseValue =
        dto.value != null && Number.isFinite(Number(dto.value))
          ? Number(dto.value)
          : null;
      const gate = gatePurchase({
        actionSource: dto.action_source,
        saleId,
        leadId,
        unitId,
        value: purchaseValue,
        currency: purchaseCurrency,
      });
      if (!gate.ok) throw new BadRequestException(gate.reason);
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

    const contentIds =
      dto.event_name === 'ViewContent'
        ? resolveViewContentContentIds({
            subtype,
            unitId,
            contentIds: dto.content_ids,
          })
        : dto.content_ids;

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
      contentName: dto.content_name,
      contentCategory: dto.content_category,
      value: purchaseValue,
      currency: purchaseCurrency,
      messagingChannel:
        dto.messaging_channel === 'whatsapp' ? 'whatsapp' : undefined,
      ctwaClid: dto.ctwa_clid,
      whatsappBusinessAccountId: dto.whatsapp_business_account_id,
      messagingDatasetId: dto.messaging_dataset_id,
    });

    const deliveryLane =
      dto.delivery_lane || (this.meta.mode === 'test' ? 'test' : 'live');

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
      },
      graph_payload: built.payload,
      dataset_id: datasetForRow,
      delivery_lane: deliveryLane,
      visitor_key: visitorKey,
      lead_id: leadId,
      ads_consent_required: true,
    });

    if (!result.inserted) {
      let qualifiedLeadPayloadConflict = false;
      if (dto.event_name === 'QualifiedLead') {
        try {
          const stored = JSON.parse(result.row.payload_redacted) as Record<
            string,
            unknown
          >;
          qualifiedLeadPayloadConflict =
            stored.temperature !== dto.temperature ||
            JSON.stringify(stored.evidence_labels || []) !==
              JSON.stringify(dto.evidence_labels || []) ||
            (stored.qualification_source || null) !==
              (dto.qualification_source || null);
        } catch {
          qualifiedLeadPayloadConflict = true;
        }
      }
      const conflicts =
        result.row.event_name !== dto.event_name ||
        result.row.delivery_lane !== deliveryLane ||
        (dto.event_id != null && result.row.event_id !== dto.event_id) ||
        (dto.event_time != null && result.row.event_time !== dto.event_time) ||
        result.row.dataset_id !== datasetForRow ||
        qualifiedLeadPayloadConflict;
      if (conflicts) {
        throw new ConflictException('idempotency_key_conflict');
      }
    }

    const sendGate = this.meta.assertSendAllowedFor(
      built.payload,
      dto.event_name,
    );
    const activeLane =
      this.meta.mode === 'test'
        ? 'test'
        : this.meta.mode === 'live'
          ? 'live'
          : null;

    let delivery: string;
    if (result.blocked_by_consent || result.row.status === 'cancelled') {
      delivery = 'cancelled:ads_consent_revoked';
    } else if (!sendGate.ok) {
      delivery = `held:${sendGate.reason}`;
    } else if (
      dto.event_name === 'QualifiedLead' &&
      !this.meta.waCrmQualificationDeliveryEnabled
    ) {
      delivery = 'held:wa_crm_qualification_delivery_inactive';
    } else if (!activeLane || activeLane !== deliveryLane) {
      delivery = 'held:lane_mismatch';
    } else {
      delivery = 'queued';
    }

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
    };
  }
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

import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MetaCapiService } from '../meta/meta-capi.service';
import {
  isLikelyArtificialEmail,
  isLikelyArtificialName,
} from '../common/utils/phone';
import type { EnqueueEventDto } from './dto/enqueue-event.dto';

@Injectable()
export class EventsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly meta: MetaCapiService,
  ) {}

  enqueue(dto: EnqueueEventDto) {
    if (!dto.ads_consent) {
      throw new BadRequestException('ads_consent requerido y debe ser true');
    }

    if (dto.action_source === 'business_messaging') {
      // Schedule WhatsApp: Meta BM no admite event_name Schedule (docs CAPI BM;
      // Graph 2804066). No renombrar ni remapear a website.
      if (dto.event_name === 'Schedule') {
        throw new BadRequestException(
          'business_messaging_schedule_not_supported_by_meta',
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
      // Nunca usar dataset web/pixel como fallback.
    }

    const leadId = dto.lead_id || dto.external_id || null;
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
      contentIds: dto.content_ids,
      contentName: dto.content_name,
      contentCategory: dto.content_category,
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
      payload_redacted: built.redacted,
      graph_payload: built.payload,
      dataset_id: datasetForRow,
      delivery_lane: deliveryLane,
      visitor_key: visitorKey,
      lead_id: leadId,
      ads_consent_required: true,
    });

    const sendGate = this.meta.assertSendAllowed();
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
    };
  }
}

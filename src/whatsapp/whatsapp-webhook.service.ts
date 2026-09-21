import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DatabaseService } from '../database/database.service'
import { resolveWaCloudWebhookFlags } from './whatsapp-flags'
import {
  assertWabaAndPhone,
  parseWhatsAppCloudWebhookBody,
  type WaCloudInboundMessage,
  type WaCloudParsedChange,
} from './whatsapp-payload'
import { verifyMetaHubSignature256 } from './whatsapp-signature'

export type LeadMatch = {
  id: string
  contact_id: string | null
  kommo_id: number | null
  tenant_id: string
  project_id: string
  whatsapp_id: string | null
  phone_normalized: string | null
}

type RejectBucket = {
  count: number
  last_status: number
  last_at: string
}

@Injectable()
export class WhatsappWebhookService {
  private readonly logger = new Logger(WhatsappWebhookService.name)
  /** Contadores en memoria (reinicio al redeploy). Solo reasons, sin PII. */
  private readonly rejectCounts = new Map<string, RejectBucket>()
  private lastReject: {
    phase: 'challenge' | 'post'
    reason: string
    status: number
    at: string
  } | null = null

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  flags() {
    return resolveWaCloudWebhookFlags({
      META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED: this.config.get<string>(
        'META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED',
      ),
      META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED: this.config.get<string>(
        'META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED',
      ),
    })
  }

  /**
   * Diagnóstico seguro de rechazos (health + logs). Sin secretos ni payloads.
   */
  recordReject(
    phase: 'challenge' | 'post',
    reason: string,
    status: number,
  ): void {
    const key = `${phase}:${reason}`
    const prev = this.rejectCounts.get(key)
    const at = new Date().toISOString()
    this.rejectCounts.set(key, {
      count: (prev?.count || 0) + 1,
      last_status: status,
      last_at: at,
    })
    this.lastReject = { phase, reason, status, at }
  }

  verifyChallenge(query: {
    mode?: string
    verifyToken?: string
    challenge?: string
  }):
    | { ok: true; challenge: string }
    | { ok: false; status: number; reason: string } {
    const flags = this.flags()
    if (!flags.challengeEnabled) {
      return { ok: false, status: 503, reason: 'challenge_disabled' }
    }
    const expected = String(
      this.config.get<string>('META_WA_VERIFY_TOKEN') || '',
    ).trim()
    if (!expected) {
      return { ok: false, status: 503, reason: 'verify_token_missing' }
    }
    if (query.mode !== 'subscribe') {
      return { ok: false, status: 400, reason: 'hub_mode_invalid' }
    }
    if (String(query.verifyToken || '') !== expected) {
      return { ok: false, status: 403, reason: 'verify_token_mismatch' }
    }
    const challenge = String(query.challenge || '')
    if (!challenge) {
      return { ok: false, status: 400, reason: 'hub_challenge_missing' }
    }
    return { ok: true, challenge }
  }

  /**
   * Firma Meta sobre body crudo. Secreto: únicamente META_WA_APP_SECRET
   * (App Secret de la app La Vilet, no el token ni META_CAPI_INTERNAL_SECRET).
   */
  verifySignature(rawBody: Buffer, signatureHeader: string | null | undefined) {
    return verifyMetaHubSignature256({
      appSecret: String(this.config.get<string>('META_WA_APP_SECRET') || ''),
      rawBody,
      signatureHeader,
    })
  }

  /**
   * Procesa POST firmado. No envía chats ni CAPI.
   * Idempotente por wamid. CTWA solo si referral.ctwa_clid viene informado.
   */
  async processSignedWebhook(body: unknown): Promise<{
    ok: true
    processed: number
    inserted: number
    duplicates: number
    pendingLink: number
    linked: number
    noReferral: number
    rejected?: never
  } | {
    ok: false
    reason: string
    status: number
  }> {
    const flags = this.flags()
    if (!flags.receiveEnabled) {
      return { ok: false, reason: 'receive_disabled', status: 503 }
    }

    const parsed = parseWhatsAppCloudWebhookBody(body)
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, status: 400 }
    }

    const expectedWabaId = String(
      this.config.get<string>('META_WABA_ID') || '',
    ).trim()
    const expectedPhoneNumberId = String(
      this.config.get<string>('META_WA_PHONE_NUMBER_ID') || '',
    ).trim()

    let processed = 0
    let inserted = 0
    let duplicates = 0
    let pendingLink = 0
    let linked = 0
    let noReferral = 0

    for (const change of parsed.changes) {
      const gate = assertWabaAndPhone({
        wabaId: change.wabaId,
        phoneNumberId: change.phoneNumberId,
        expectedWabaId,
        expectedPhoneNumberId,
      })
      if (!gate.ok) {
        this.logger.warn(
          JSON.stringify({
            event: 'wa_cloud_webhook_rejected',
            reason: gate.reason,
          }),
        )
        return { ok: false, reason: gate.reason, status: 403 }
      }

      for (const message of change.messages) {
        const result = await this.persistMessage(change, message)
        processed += 1
        if (result.duplicate) duplicates += 1
        else inserted += 1
        if (result.linkStatus === 'seen_no_referral') noReferral += 1
        if (result.linkStatus === 'pending_link' || result.linkStatus === 'pending_ambiguous') {
          pendingLink += 1
        }
        if (result.linkStatus === 'linked') linked += 1
      }
    }

    return {
      ok: true,
      processed,
      inserted,
      duplicates,
      pendingLink,
      linked,
      noReferral,
    }
  }

  private async persistMessage(
    change: WaCloudParsedChange,
    message: WaCloudInboundMessage,
  ): Promise<{ duplicate: boolean; linkStatus: string }> {
    const hasCtwa = Boolean(message.referral?.ctwaClid)
    const initialStatus = hasCtwa ? 'pending_link' : 'seen_no_referral'
    const { inserted, row } = this.db.insertWaCloudReceipt({
      wamid: message.wamid,
      waIdRaw: message.waIdRaw,
      waIdNormalized: message.waIdNormalized,
      phoneNumberId: change.phoneNumberId,
      wabaId: change.wabaId,
      hasCtwa,
      ctwaClid: message.referral?.ctwaClid ?? null,
      referralSourceType: message.referral?.sourceType ?? null,
      sourceId: message.referral?.sourceId ?? null,
      sourceUrl: message.referral?.sourceUrl ?? null,
      fieldPath: message.referral?.fieldPath ?? null,
      linkStatus: initialStatus,
    })

    this.logger.log(
      JSON.stringify({
        event: 'wa_cloud_message_receipt',
        wamid_present: true,
        has_ctwa: hasCtwa,
        inserted,
        link_status: row.link_status,
        // sin clid, wa_id ni texto
      }),
    )

    if (!inserted) {
      return { duplicate: true, linkStatus: row.link_status }
    }
    if (!hasCtwa) {
      return { duplicate: false, linkStatus: 'seen_no_referral' }
    }

    const linkStatus = await this.correlateAndMaybeSync(row.wamid)
    return { duplicate: false, linkStatus }
  }

  async correlateAndMaybeSync(wamid: string): Promise<string> {
    const row = this.db.getWaCloudReceipt(wamid)
    if (!row || !row.has_ctwa || !row.ctwa_clid) {
      return row?.link_status || 'seen_no_referral'
    }
    if (row.link_status === 'linked' && row.supabase_synced) {
      return 'linked'
    }

    const matches = await this.findLeadMatches(row.wa_id_normalized, row.wa_id_raw)
    if (matches.length === 0) {
      this.db.updateWaCloudReceiptLink(wamid, {
        linkStatus: 'pending_link',
        lastError: null,
      })
      return 'pending_link'
    }
    if (matches.length > 1) {
      this.db.updateWaCloudReceiptLink(wamid, {
        linkStatus: 'pending_ambiguous',
        lastError: 'multiple_leads_for_wa_id',
      })
      this.logger.warn(
        JSON.stringify({
          event: 'wa_cloud_correlate_ambiguous',
          match_count: matches.length,
        }),
      )
      return 'pending_ambiguous'
    }

    const lead = matches[0]
    if (!lead.contact_id || lead.kommo_id == null) {
      this.db.updateWaCloudReceiptLink(wamid, {
        linkStatus: 'pending_link',
        leadId: lead.id,
        tenantId: lead.tenant_id,
        projectId: lead.project_id,
        lastError: 'lead_missing_kommo_contact',
      })
      return 'pending_link'
    }

    this.db.updateWaCloudReceiptLink(wamid, {
      linkStatus: 'linked',
      leadId: lead.id,
      contactId: lead.contact_id,
      kommoId: lead.kommo_id,
      tenantId: lead.tenant_id,
      projectId: lead.project_id,
      lastError: null,
    })

    const synced = await this.syncPreserveCtwa({
      tenantId: lead.tenant_id,
      projectId: lead.project_id,
      contactId: lead.contact_id,
      kommoId: lead.kommo_id,
      ctwaClid: row.ctwa_clid,
      fieldPath: row.field_path || 'meta_cloud.messages[].referral.ctwa_clid',
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      referralSourceType: row.referral_source_type,
      externalMessageId: row.wamid,
    })

    this.db.updateWaCloudReceiptLink(wamid, {
      linkStatus: synced.ok ? 'linked' : 'sync_failed',
      supabaseSynced: synced.ok,
      lastError: synced.ok ? null : synced.reason,
    })
    return synced.ok ? 'linked' : 'sync_failed'
  }

  async reconcilePending(limit = 50): Promise<{ tried: number; linked: number }> {
    const pending = this.db.listPendingWaCloudReceipts(limit)
    let linked = 0
    for (const row of pending) {
      const status = await this.correlateAndMaybeSync(row.wamid)
      if (status === 'linked') linked += 1
    }
    return { tried: pending.length, linked }
  }

  private async findLeadMatches(
    waIdNormalized: string | null,
    waIdRaw: string,
  ): Promise<LeadMatch[]> {
    const url = String(this.config.get<string>('SUPABASE_URL') || '').trim()
    const key = String(
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
    ).trim()
    if (!url || !key) {
      return []
    }

    const candidates = new Set<string>()
    if (waIdNormalized) candidates.add(waIdNormalized)
    const rawDigits = String(waIdRaw || '').replace(/\D/g, '')
    if (rawDigits) candidates.add(rawDigits)

    const byId = new Map<string, LeadMatch>()
    for (const candidate of candidates) {
      const qs = new URLSearchParams({
        select: 'id,contact_id,kommo_id,tenant_id,project_id,whatsapp_id,phone_normalized',
        or: `(whatsapp_id.eq.${candidate},phone_normalized.eq.${candidate})`,
        limit: '5',
      })
      const res = await fetch(`${url}/rest/v1/leads?${qs}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      })
      if (!res.ok) {
        this.logger.warn(
          JSON.stringify({
            event: 'wa_cloud_lead_lookup_failed',
            http: res.status,
          }),
        )
        continue
      }
      const rows = (await res.json()) as LeadMatch[]
      for (const row of rows) {
        if (row?.id) byId.set(row.id, row)
      }
    }
    return [...byId.values()]
  }

  private async syncPreserveCtwa(input: {
    tenantId: string
    projectId: string
    contactId: string
    kommoId: number
    ctwaClid: string
    fieldPath: string
    sourceId: string | null
    sourceUrl: string | null
    referralSourceType: string | null
    externalMessageId: string
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = String(this.config.get<string>('SUPABASE_URL') || '').trim()
    const key = String(
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
    ).trim()
    if (!url || !key) {
      // Persistencia local ya ocurrió; sync CRM opcional hasta tener credenciales.
      return { ok: false, reason: 'supabase_not_configured' }
    }

    const res = await fetch(`${url}/rest/v1/rpc/lv_app_preserve_ctwa`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: input.tenantId,
        p_project_id: input.projectId,
        p_contact_id: input.contactId,
        p_kommo_id: input.kommoId,
        p_ctwa_clid: input.ctwaClid,
        p_field_path: input.fieldPath,
        p_source_id: input.sourceId,
        p_source_url: input.sourceUrl,
        p_referral_source_type: input.referralSourceType,
        p_external_message_id: input.externalMessageId,
      }),
    })
    if (!res.ok) {
      return { ok: false, reason: `preserve_http_${res.status}` }
    }
    const json = (await res.json()) as { ok?: boolean; action?: string }
    if (json?.ok !== true) {
      return { ok: false, reason: 'preserve_rejected' }
    }
    this.logger.log(
      JSON.stringify({
        event: 'wa_cloud_ctwa_preserved',
        action: json.action || null,
      }),
    )
    return { ok: true }
  }

  healthSnapshot() {
    const flags = this.flags()
    const reject_counts: Record<string, RejectBucket> = {}
    for (const [key, value] of this.rejectCounts.entries()) {
      reject_counts[key] = value
    }
    return {
      challenge_enabled: flags.challengeEnabled,
      receive_enabled: flags.receiveEnabled,
      verify_token_configured: Boolean(
        String(this.config.get<string>('META_WA_VERIFY_TOKEN') || '').trim(),
      ),
      app_secret_configured: Boolean(
        String(this.config.get<string>('META_WA_APP_SECRET') || '').trim(),
      ),
      /** Nombre de env usado en HMAC (valor nunca expuesto). */
      app_secret_env: 'META_WA_APP_SECRET',
      waba_id_configured: Boolean(
        String(this.config.get<string>('META_WABA_ID') || '').trim(),
      ),
      phone_number_id_configured: Boolean(
        String(this.config.get<string>('META_WA_PHONE_NUMBER_ID') || '').trim(),
      ),
      receipt_counts: this.db.countsWaCloudReceipts(),
      reject_counts,
      last_reject: this.lastReject,
    }
  }
}

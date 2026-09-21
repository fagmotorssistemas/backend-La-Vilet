import {
  Controller,
  Get,
  Headers,
  HttpException,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request, Response } from 'express'
import { WhatsappWebhookService } from './whatsapp-webhook.service'

/**
 * Rutas 401 en este controlador (únicas en /api/whatsapp/webhook):
 * - POST firma: app_secret_missing | signature_header_invalid | signature_mismatch
 * No hay guards globales ni InternalSecretGuard en este path.
 * GET challenge usa 403/400/503, nunca 401.
 */
@Controller('whatsapp/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name)

  constructor(private readonly webhook: WhatsappWebhookService) {}

  /**
   * Meta App Dashboard / subscribed_apps verification (hub.challenge).
   * Disponible con CHALLENGE=true aunque RECEIVE=false.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const result = this.webhook.verifyChallenge({
      mode,
      verifyToken,
      challenge,
    })
    if (!result.ok) {
      this.webhook.recordReject('challenge', result.reason, result.status)
      this.logger.warn(
        JSON.stringify({
          event: 'wa_cloud_webhook_challenge_rejected',
          reason: result.reason,
          status: result.status,
        }),
      )
      throw new HttpException({ ok: false, reason: result.reason }, result.status)
    }
    // Meta espera el challenge en texto plano.
    res.status(200).type('text/plain').send(result.challenge)
  }

  /**
   * Mensajes Cloud API. No responde chats ni envía CAPI.
   * RECEIVE=false → 503 (no 200 silencioso).
   * Firma HMAC-SHA256 sobre rawBody con META_WA_APP_SECRET.
   */
  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const contentLength = Number(req.headers['content-length'] || 0) || null
    this.logger.log(
      JSON.stringify({
        event: 'wa_cloud_webhook_post',
        signature_header_present: Boolean(
          signature && String(signature).trim(),
        ),
        content_length: contentLength,
        // sin body, sin firma, sin teléfonos
      }),
    )

    const rawBody = req.rawBody
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      this.webhook.recordReject('post', 'raw_body_unavailable', 500)
      this.logger.warn(
        JSON.stringify({
          event: 'wa_cloud_webhook_rejected',
          reason: 'raw_body_unavailable',
          status: 500,
          content_length: contentLength,
          raw_body_type:
            rawBody == null ? 'missing' : typeof rawBody,
        }),
      )
      throw new HttpException(
        { ok: false, reason: 'raw_body_unavailable' },
        500,
      )
    }

    const sig = this.webhook.verifySignature(rawBody, signature)
    if (!sig.ok) {
      this.webhook.recordReject('post', sig.reason, 401)
      this.logger.warn(
        JSON.stringify({
          event: 'wa_cloud_webhook_rejected',
          reason: sig.reason,
          status: 401,
          secret_env: 'META_WA_APP_SECRET',
          diag: sig.diag,
        }),
      )
      throw new HttpException(
        { ok: false, reason: sig.reason, diag: sig.diag },
        401,
      )
    }

    let body: unknown = req.body
    if (
      body == null ||
      (typeof body === 'object' && Object.keys(body as object).length === 0)
    ) {
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        this.webhook.recordReject('post', 'body_json_invalid', 400)
        this.logger.warn(
          JSON.stringify({
            event: 'wa_cloud_webhook_rejected',
            reason: 'body_json_invalid',
            status: 400,
            raw_body_bytes: rawBody.length,
          }),
        )
        throw new HttpException({ ok: false, reason: 'body_json_invalid' }, 400)
      }
    }

    const result = await this.webhook.processSignedWebhook(body)
    if (!result.ok) {
      this.webhook.recordReject('post', result.reason, result.status)
      this.logger.warn(
        JSON.stringify({
          event: 'wa_cloud_webhook_rejected',
          reason: result.reason,
          status: result.status,
        }),
      )
      throw new HttpException(
        { ok: false, reason: result.reason },
        result.status,
      )
    }
    return {
      ok: true,
      processed: result.processed,
      inserted: result.inserted,
      duplicates: result.duplicates,
      pending_link: result.pendingLink,
      linked: result.linked,
      no_referral: result.noReferral,
    }
  }
}

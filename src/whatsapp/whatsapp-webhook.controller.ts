import {
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request, Response } from 'express'
import { WhatsappWebhookService } from './whatsapp-webhook.service'

@Controller('whatsapp/webhook')
export class WhatsappWebhookController {
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
      throw new HttpException({ ok: false, reason: result.reason }, result.status)
    }
    // Meta espera el challenge en texto plano.
    res.status(200).type('text/plain').send(result.challenge)
  }

  /**
   * Mensajes Cloud API. No responde chats ni envía CAPI.
   * RECEIVE=false → 503 (no 200 silencioso).
   */
  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const rawBody = req.rawBody
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      throw new HttpException(
        { ok: false, reason: 'raw_body_unavailable' },
        500,
      )
    }

    const sig = this.webhook.verifySignature(rawBody, signature)
    if (!sig.ok) {
      throw new HttpException({ ok: false, reason: sig.reason }, 401)
    }

    let body: unknown = req.body
    if (body == null || (typeof body === 'object' && Object.keys(body as object).length === 0)) {
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        throw new HttpException({ ok: false, reason: 'body_json_invalid' }, 400)
      }
    }

    const result = await this.webhook.processSignedWebhook(body)
    if (!result.ok) {
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

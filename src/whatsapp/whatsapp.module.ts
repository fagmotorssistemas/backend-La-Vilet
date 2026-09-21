import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { WhatsappWebhookController } from './whatsapp-webhook.controller'
import { WhatsappWebhookService } from './whatsapp-webhook.service'

@Module({
  imports: [DatabaseModule],
  controllers: [WhatsappWebhookController],
  providers: [WhatsappWebhookService],
  exports: [WhatsappWebhookService],
})
export class WhatsappModule {}

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetaModule } from '../meta/meta.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DrainModule } from '../drain/drain.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [MetaModule, OutboxModule, DrainModule, WhatsappModule],
  controllers: [HealthController],
})
export class HealthModule {}

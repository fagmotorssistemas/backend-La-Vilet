import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetaModule } from '../meta/meta.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DrainModule } from '../drain/drain.module';

@Module({
  imports: [MetaModule, OutboxModule, DrainModule],
  controllers: [HealthController],
})
export class HealthModule {}

import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { MetaModule } from '../meta/meta.module';

@Module({
  imports: [MetaModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}

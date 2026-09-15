import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { MetaModule } from '../meta/meta.module';
import { SupabaseDrainService } from './supabase-drain.service';

@Module({
  imports: [DatabaseModule, EventsModule, MetaModule],
  providers: [SupabaseDrainService],
  exports: [SupabaseDrainService],
})
export class DrainModule {}

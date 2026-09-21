import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { MetaModule } from './meta/meta.module';
import { OutboxModule } from './outbox/outbox.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ConsentModule } from './consent/consent.module';
import { DrainModule } from './drain/drain.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    AuthModule,
    DatabaseModule,
    MetaModule,
    OutboxModule,
    EventsModule,
    ConsentModule,
    DrainModule,
    WhatsappModule,
    HealthModule,
  ],
})
export class AppModule {}

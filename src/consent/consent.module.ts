import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ConsentController } from './consent.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ConsentController],
})
export class ConsentModule {}

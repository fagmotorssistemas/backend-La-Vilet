import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { InternalSecretGuard } from '../auth/auth.module';
import { DatabaseService } from '../database/database.service';

class ConsentScopeDto {
  @IsOptional()
  @IsUUID('4')
  lead_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  visitor_key?: string;
}

@Controller('v1/consent')
@UseGuards(InternalSecretGuard)
export class ConsentController {
  constructor(private readonly db: DatabaseService) {}

  @Post('revoke')
  @HttpCode(202)
  revoke(@Body() body: ConsentScopeDto) {
    let cancelled = 0;
    if (body.lead_id) {
      cancelled += this.db.revokeConsent('lead', body.lead_id);
    }
    if (body.visitor_key) {
      cancelled += this.db.revokeConsent('visitor', body.visitor_key);
    }
    return {
      ok: true,
      cancelled,
      lead_id: body.lead_id || null,
      visitor_key: body.visitor_key || null,
    };
  }

  @Post('grant')
  @HttpCode(202)
  grant(@Body() body: ConsentScopeDto) {
    if (body.lead_id) this.db.grantConsent('lead', body.lead_id);
    if (body.visitor_key) this.db.grantConsent('visitor', body.visitor_key);
    return {
      ok: true,
      lead_id: body.lead_id || null,
      visitor_key: body.visitor_key || null,
    };
  }
}

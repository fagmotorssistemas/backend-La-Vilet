import { Body, Controller, HttpCode, Post, UseGuards, BadRequestException } from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
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

  /** Obligatorio: orden monotónico desde secuencia Supabase. */
  @IsInt()
  @Min(1)
  consent_version!: number;
}

@Controller('v1/consent')
@UseGuards(InternalSecretGuard)
export class ConsentController {
  constructor(private readonly db: DatabaseService) {}

  @Post('revoke')
  @HttpCode(202)
  revoke(@Body() body: ConsentScopeDto) {
    if (!body.consent_version) {
      throw new BadRequestException('consent_version requerido');
    }
    const version = body.consent_version;
    let cancelled = 0;
    if (body.lead_id) {
      cancelled += this.db.revokeConsent('lead', body.lead_id, version);
    }
    if (body.visitor_key) {
      cancelled += this.db.revokeConsent('visitor', body.visitor_key, version);
    }
    return {
      ok: true,
      cancelled,
      consent_version: version,
      lead_id: body.lead_id || null,
      visitor_key: body.visitor_key || null,
    };
  }

  @Post('grant')
  @HttpCode(202)
  grant(@Body() body: ConsentScopeDto) {
    if (!body.consent_version) {
      throw new BadRequestException('consent_version requerido');
    }
    const version = body.consent_version;
    const results: { scope: string; applied: boolean }[] = [];
    if (body.lead_id) {
      results.push({
        scope: 'lead',
        applied: this.db.grantConsent('lead', body.lead_id, version),
      });
    }
    if (body.visitor_key) {
      results.push({
        scope: 'visitor',
        applied: this.db.grantConsent('visitor', body.visitor_key, version),
      });
    }
    return {
      ok: true,
      applied: results.some((r) => r.applied),
      results,
      consent_version: version,
      lead_id: body.lead_id || null,
      visitor_key: body.visitor_key || null,
    };
  }
}

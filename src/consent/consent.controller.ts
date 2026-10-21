import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
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

export class ConsentScopeDto {
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

/** Al menos un alcance no vacío: si no, la revocación no tendría efecto. */
function requireScope(body: ConsentScopeDto): {
  leadId: string | null;
  visitorKey: string | null;
} {
  const leadId = String(body.lead_id ?? '').trim() || null;
  const visitorKey = String(body.visitor_key ?? '').trim() || null;
  if (!leadId && !visitorKey) {
    throw new BadRequestException('consent_scope_required');
  }
  return { leadId, visitorKey };
}

@Controller('v1/consent')
@UseGuards(InternalSecretGuard)
export class ConsentController {
  constructor(private readonly db: DatabaseService) {}

  @Post('revoke')
  @HttpCode(202)
  revoke(@Body() body: ConsentScopeDto) {
    const { leadId, visitorKey } = requireScope(body);
    const version = body.consent_version;
    let cancelled = 0;
    if (leadId) {
      cancelled += this.db.revokeConsent('lead', leadId, version);
    }
    if (visitorKey) {
      cancelled += this.db.revokeConsent('visitor', visitorKey, version);
    }
    return {
      ok: true,
      cancelled,
      consent_version: version,
      lead_id: leadId,
      visitor_key: visitorKey,
    };
  }

  @Post('grant')
  @HttpCode(202)
  grant(@Body() body: ConsentScopeDto) {
    const { leadId, visitorKey } = requireScope(body);
    const version = body.consent_version;
    const results: { scope: string; applied: boolean }[] = [];
    if (leadId) {
      results.push({
        scope: 'lead',
        applied: this.db.grantConsent('lead', leadId, version),
      });
    }
    if (visitorKey) {
      results.push({
        scope: 'visitor',
        applied: this.db.grantConsent('visitor', visitorKey, version),
      });
    }
    return {
      ok: true,
      applied: results.some((r) => r.applied),
      results,
      consent_version: version,
      lead_id: leadId,
      visitor_key: visitorKey,
    };
  }
}

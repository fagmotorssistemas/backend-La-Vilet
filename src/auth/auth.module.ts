import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = configuredInternalSecret(this.config);
    if (!expected) {
      throw new UnauthorizedException(
        'Servicio mal configurado: falta META_CAPI_INTERNAL_SECRET',
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    if (!hasValidInternalSecret(req, this.config)) {
      throw new UnauthorizedException('No autorizado');
    }
    return true;
  }
}

function configuredInternalSecret(config: ConfigService): string | null {
  const expected = String(
    config.get<string>('META_CAPI_INTERNAL_SECRET') || '',
  ).trim();
  return expected && expected.length >= 16 ? expected : null;
}

/** X-Internal-Secret o Bearer con el secreto interno. Nunca lanza. */
export function hasValidInternalSecret(
  req: Request,
  config: ConfigService,
): boolean {
  const expected = configuredInternalSecret(config);
  if (!expected) return false;
  const headerSecret = String(req.headers['x-internal-secret'] || '').trim();
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : '';
  const provided = headerSecret || bearer;
  return Boolean(provided) && safeEqual(provided, expected);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Module({
  providers: [InternalSecretGuard],
  exports: [InternalSecretGuard],
})
export class AuthModule {}

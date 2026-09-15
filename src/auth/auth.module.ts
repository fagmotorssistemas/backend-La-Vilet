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
    const expected = String(
      this.config.get<string>('META_CAPI_INTERNAL_SECRET') || '',
    ).trim();
    if (!expected || expected.length < 16) {
      throw new UnauthorizedException(
        'Servicio mal configurado: falta META_CAPI_INTERNAL_SECRET',
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const headerSecret = String(req.headers['x-internal-secret'] || '').trim();
    const auth = String(req.headers.authorization || '').trim();
    const bearer = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : '';
    const provided = headerSecret || bearer;

    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('No autorizado');
    }
    return true;
  }
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

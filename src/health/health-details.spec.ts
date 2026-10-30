import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { HealthController, isDirectLoopback } from './health.controller';

const SECRET = 'internal-secret-0123456789';

function req(opts: {
  remote?: string;
  headers?: Record<string, string>;
}): Request {
  return {
    headers: opts.headers || {},
    socket: { remoteAddress: opts.remote || '172.17.0.1' },
  } as unknown as Request;
}

function controller(env: Record<string, string>) {
  const config = {
    get: (key: string) => ({ META_CAPI_INTERNAL_SECRET: SECRET, ...env })[key],
  } as ConfigService;
  const details = { ok: true, detail: 'full' };
  const c = new HealthController(
    config,
    { mode: 'live' } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (c as unknown as { healthDetails: () => unknown }).healthDetails = () =>
    details;
  return { c, details };
}

describe('/api/health — detalle', () => {
  it('por defecto el detalle sigue siendo público (sin romper scripts)', () => {
    const { c, details } = controller({});
    expect(c.getHealth(req({}))).toBe(details);
  });

  it('HEALTH_DETAILS_PUBLIC=false: público solo ok/service/mode', () => {
    const { c } = controller({ HEALTH_DETAILS_PUBLIC: 'false' });
    expect(c.getHealth(req({}))).toEqual({
      ok: true,
      service: 'lavilet-meta-capi',
      mode: 'live',
    });
  });

  it('HEALTH_DETAILS_PUBLIC=false: con el secreto interno, detalle completo', () => {
    const { c, details } = controller({ HEALTH_DETAILS_PUBLIC: 'false' });
    expect(c.getHealth(req({ headers: { 'x-internal-secret': SECRET } }))).toBe(
      details,
    );
    expect(
      c.getHealth(req({ headers: { 'x-internal-secret': 'otro' } })),
    ).not.toBe(details);
  });

  it('loopback directo sí; con cabecera de proxy no', () => {
    expect(isDirectLoopback(req({ remote: '127.0.0.1' }))).toBe(true);
    expect(
      isDirectLoopback(
        req({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }),
      ),
    ).toBe(false);
    expect(isDirectLoopback(req({ remote: '172.17.0.1' }))).toBe(false);
  });
});

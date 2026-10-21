import { BadRequestException } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { DatabaseService } from '../database/database.service';

describe('ConsentController — alcance obligatorio', () => {
  const lead = '11111111-1111-4111-8111-111111111111';

  function make() {
    const db = {
      revokeConsent: jest.fn(() => 2),
      grantConsent: jest.fn(() => true),
    };
    return {
      db,
      controller: new ConsentController(db as unknown as DatabaseService),
    };
  }

  it.each([
    { consent_version: 3 },
    { consent_version: 3, visitor_key: '   ' },
    { consent_version: 3, visitor_key: '' },
  ])('revoke sin alcance útil → 400 (%o)', (body) => {
    const { controller, db } = make();
    expect(() => controller.revoke(body)).toThrow(
      new BadRequestException('consent_scope_required'),
    );
    expect(db.revokeConsent).not.toHaveBeenCalled();
  });

  it('grant sin alcance útil → 400', () => {
    const { controller, db } = make();
    expect(() => controller.grant({ consent_version: 3 })).toThrow(
      'consent_scope_required',
    );
    expect(db.grantConsent).not.toHaveBeenCalled();
  });

  it('revoke con lead y visitor aplica ambos alcances', () => {
    const { controller, db } = make();
    const result = controller.revoke({
      consent_version: 4,
      lead_id: lead,
      visitor_key: ' visitor-1 ',
    });
    expect(db.revokeConsent).toHaveBeenCalledWith('lead', lead, 4);
    expect(db.revokeConsent).toHaveBeenCalledWith('visitor', 'visitor-1', 4);
    expect(result).toMatchObject({
      ok: true,
      cancelled: 4,
      lead_id: lead,
      visitor_key: 'visitor-1',
    });
  });
});

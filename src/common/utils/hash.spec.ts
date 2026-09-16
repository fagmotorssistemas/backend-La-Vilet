import {
  normalizePhoneE164Digits,
  hashEmail,
  hashPhone,
  hashNamePart,
  buildHashedUserData,
  splitFullName,
} from './hash';
import { isLikelyArtificialEmail, isLikelyArtificialName } from './phone';

describe('hash + phone', () => {
  it('normaliza Ecuador y conserva extranjero', () => {
    expect(normalizePhoneE164Digits('0991234567')).toBe('593991234567');
    expect(normalizePhoneE164Digits('+1 (415) 555-0100')).toBe('14155550100');
  });

  it('hashea email/teléfono y bloquea artificiales', () => {
    expect(hashEmail('A@B.com')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashEmail('wa.991234567@showroom.lavilet')).toBeNull();
    expect(hashPhone('0991234567')).toMatch(/^[a-f0-9]{64}$/);
    expect(isLikelyArtificialName('WhatsApp ····4567')).toBe(true);
    expect(isLikelyArtificialEmail('wa.1@showroom.lavilet')).toBe(true);
  });

  it('buildHashedUserData omite inventados', () => {
    const data = buildHashedUserData({
      phone: '0991234567',
      email: 'wa.1@showroom.lavilet',
      firstName: 'WhatsApp ····1234',
      country: 'ec',
      externalId: 'lead-1',
    });
    expect(data.ph).toBeDefined();
    expect(data.em).toBeUndefined();
    expect(data.fn).toBeUndefined();
    expect(data.external_id).toBeDefined();
  });

  it('prioriza first/last separados y no infiere full_name ambiguo', () => {
    expect(splitFullName('Juan Pérez')).toEqual({
      firstName: 'Juan',
      lastName: 'Pérez',
    });
    expect(splitFullName('Ana')).toEqual({
      firstName: 'Ana',
      lastName: null,
    });

    // 3+ tokens: no asumir "últimas dos = apellidos"
    expect(splitFullName('María José Pérez')).toEqual({
      firstName: null,
      lastName: null,
    });
    expect(splitFullName('Juan Diego Aguirre Armijos')).toEqual({
      firstName: null,
      lastName: null,
    });
    expect(splitFullName('María Pérez de la Cruz')).toEqual({
      firstName: null,
      lastName: null,
    });

    const fromFull = buildHashedUserData({
      fullName: 'María José Pérez',
      phone: '0991234567',
    });
    expect(fromFull.fn).toBeUndefined();
    expect(fromFull.ln).toBeUndefined();
    expect(fromFull.ph).toBeDefined();

    const separated = buildHashedUserData({
      firstName: 'María José',
      lastName: 'Pérez',
      fullName: 'María José Pérez algo extra',
      phone: '0991234567',
    });
    expect(separated.fn).toEqual([hashNamePart('María José')]);
    expect(separated.ln).toEqual([hashNamePart('Pérez')]);

    // Un solo campo separado: no completar el otro desde fullName
    const onlyFirst = buildHashedUserData({
      firstName: 'María José',
      fullName: 'María José Pérez',
    });
    expect(onlyFirst.fn).toEqual([hashNamePart('María José')]);
    expect(onlyFirst.ln).toBeUndefined();
  });
});

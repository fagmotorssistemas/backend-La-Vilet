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

  it('parte full_name con nombres compuestos y dos apellidos', () => {
    expect(splitFullName('Juan Pérez')).toEqual({
      firstName: 'Juan',
      lastName: 'Pérez',
    });
    expect(splitFullName('Juan Diego Aguirre Armijos')).toEqual({
      firstName: 'Juan Diego',
      lastName: 'Aguirre Armijos',
    });
    expect(splitFullName('María José García López')).toEqual({
      firstName: 'María José',
      lastName: 'García López',
    });
    // Tres tokens: en LatAm suele ser nombre + dos apellidos
    expect(splitFullName('Ana Pérez García')).toEqual({
      firstName: 'Ana',
      lastName: 'Pérez García',
    });
    const data = buildHashedUserData({
      fullName: 'Juan Diego Aguirre Armijos',
      phone: '0991234567',
      country: 'EC',
    });
    expect(data.fn).toEqual([hashNamePart('Juan Diego')]);
    expect(data.ln).toEqual([hashNamePart('Aguirre Armijos')]);
    // No debe hashear el nombre completo concatenado como un solo fn
    expect(data.fn?.[0]).not.toEqual(hashNamePart('Juan Diego Aguirre Armijos'));
  });
});

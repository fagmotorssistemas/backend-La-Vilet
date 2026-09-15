import {
  normalizePhoneE164Digits,
  hashEmail,
  hashPhone,
  buildHashedUserData,
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
});

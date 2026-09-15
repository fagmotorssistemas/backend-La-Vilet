import { createHash, randomUUID } from 'crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function asTrimmedString(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  return value || null;
}

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function hashEmail(raw: unknown): string | null {
  const value = asTrimmedString(raw)?.toLowerCase() ?? null;
  if (!value || !value.includes('@')) return null;
  if (/@showroom\.lavilet$/i.test(value) || /^wa\.\d+@/i.test(value))
    return null;
  return sha256Hex(value);
}

export function normalizePhoneE164Digits(raw: unknown): string | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('593')) {
    const national = digits.slice(3).replace(/^0+/, '');
    if (!national) return null;
    return `593${national}`;
  }

  if (/^0?9\d{8}$/.test(digits)) {
    const national = digits.replace(/^0+/, '');
    return `593${national}`;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return digits.replace(/^0+/, '') || null;
  }

  return null;
}

export function hashPhone(raw: unknown): string | null {
  const normalized = normalizePhoneE164Digits(raw);
  if (!normalized) return null;
  return sha256Hex(normalized);
}

export function hashNamePart(raw: unknown): string | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  const value = stripDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!value) return null;
  if (value.startsWith('whatsapp') || value === 'visitante') return null;
  return sha256Hex(value);
}

export function hashCity(raw: unknown): string | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  const value = stripDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!value) return null;
  return sha256Hex(value);
}

export function hashCountry(raw: unknown): string | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  let value = stripDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (value === 'ecuador') value = 'ec';
  if (value.length !== 2) return null;
  return sha256Hex(value);
}

export function hashExternalId(raw: unknown): string | null {
  const value = asTrimmedString(raw)?.toLowerCase() ?? null;
  if (!value) return null;
  return sha256Hex(value);
}

export function newEventId(): string {
  return randomUUID();
}

export type MatchInput = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  city?: string | null;
  country?: string | null;
  externalId?: string | null;
};

export function buildHashedUserData(
  input: MatchInput,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const em = hashEmail(input.email);
  const ph = hashPhone(input.phone);
  const fn =
    hashNamePart(input.firstName) ||
    (input.lastName ? null : hashNamePart(input.fullName));
  const ln = hashNamePart(input.lastName);
  const ct = hashCity(input.city);
  const country = hashCountry(input.country);
  const externalId = hashExternalId(input.externalId);

  if (em) out.em = [em];
  if (ph) out.ph = [ph];
  if (fn) out.fn = [fn];
  if (ln) out.ln = [ln];
  if (ct) out.ct = [ct];
  if (country) out.country = [country];
  if (externalId) out.external_id = [externalId];
  return out;
}

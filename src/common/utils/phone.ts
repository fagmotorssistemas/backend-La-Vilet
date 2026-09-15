export { normalizePhoneE164Digits as normalizePhone } from './hash';

export function isLikelyArtificialEmail(email: unknown): boolean {
  if (typeof email !== 'string') return true;
  const value = email.trim().toLowerCase();
  return (
    !value || /@showroom\.lavilet$/i.test(value) || /^wa\.\d+@/i.test(value)
  );
}

export function isLikelyArtificialName(name: unknown): boolean {
  if (typeof name !== 'string') return true;
  const value = name.trim().toLowerCase();
  return !value || value.startsWith('whatsapp') || /^whatsapp\s*·/.test(value);
}

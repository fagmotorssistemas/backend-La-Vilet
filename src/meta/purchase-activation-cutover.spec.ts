import {
  isPurchaseEligibleAfterActivation,
  parseExistingTimestampMs,
  parsePurchaseActivatedAtMs,
} from './purchase-activation-cutover'

describe('purchase activation cutover', () => {
  const cut = Date.parse('2026-09-22T21:30:00.000Z')

  it('exige ACTIVATED_AT válido', () => {
    expect(parsePurchaseActivatedAtMs('')).toBeNull()
    expect(parsePurchaseActivatedAtMs('nope')).toBeNull()
    expect(parsePurchaseActivatedAtMs('2026-09-22T21:30:00.000Z')).toBe(cut)
  })

  it('rechaza histórico registrado tras el corte (sale_at anterior)', () => {
    expect(
      isPurchaseEligibleAfterActivation({
        registeredAtMs: cut + 60_000,
        commercialConfirmedAtMs: cut - 86_400_000,
        activatedAtMs: cut,
      }),
    ).toBe(false)
  })

  it('exige registered_at y sale_at ambos >= corte', () => {
    expect(
      isPurchaseEligibleAfterActivation({
        registeredAtMs: cut,
        commercialConfirmedAtMs: cut,
        activatedAtMs: cut,
      }),
    ).toBe(true)
    expect(
      isPurchaseEligibleAfterActivation({
        registeredAtMs: cut - 1,
        commercialConfirmedAtMs: cut,
        activatedAtMs: cut,
      }),
    ).toBe(false)
    expect(
      isPurchaseEligibleAfterActivation({
        registeredAtMs: cut,
        commercialConfirmedAtMs: null,
        activatedAtMs: cut,
      }),
    ).toBe(false)
  })

  it('parseExistingTimestampMs no inventa', () => {
    expect(parseExistingTimestampMs(null)).toBeNull()
    expect(parseExistingTimestampMs('')).toBeNull()
    expect(parseExistingTimestampMs('2026-09-22T21:30:00.000Z')).toBe(cut)
  })
})

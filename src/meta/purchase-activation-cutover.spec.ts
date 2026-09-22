import {
  isPurchaseRegisteredAfterActivation,
  parsePurchaseActivatedAtMs,
} from './purchase-activation-cutover'

describe('purchase activation cutover', () => {
  it('exige ACTIVATED_AT válido', () => {
    expect(parsePurchaseActivatedAtMs('')).toBeNull()
    expect(parsePurchaseActivatedAtMs('nope')).toBeNull()
    expect(
      parsePurchaseActivatedAtMs('2026-09-22T21:30:00.000Z'),
    ).toBe(Date.parse('2026-09-22T21:30:00.000Z'))
  })

  it('solo registros en/tras el corte; sale_at backdated no aplica aquí', () => {
    const cut = Date.parse('2026-09-22T21:30:00.000Z')
    expect(
      isPurchaseRegisteredAfterActivation({
        registeredAtMs: cut,
        activatedAtMs: cut,
      }),
    ).toBe(true)
    expect(
      isPurchaseRegisteredAfterActivation({
        registeredAtMs: cut - 1,
        activatedAtMs: cut,
      }),
    ).toBe(false)
    expect(
      isPurchaseRegisteredAfterActivation({
        registeredAtMs: cut + 60_000,
        activatedAtMs: cut,
      }),
    ).toBe(true)
    expect(
      isPurchaseRegisteredAfterActivation({
        registeredAtMs: cut + 1,
        activatedAtMs: null,
      }),
    ).toBe(false)
  })
})

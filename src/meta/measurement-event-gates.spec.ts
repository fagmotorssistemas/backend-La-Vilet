import { gateAddToWishlist, gatePurchase, gateViewContent, normalizeCurrency, resolveViewContentContentIds } from './measurement-event-gates';

describe('measurement-event-gates', () => {
  it('ViewContent showroom_general no exige unit', () => {
    expect(
      gateViewContent({ subtype: 'showroom_general', unitId: null }),
    ).toEqual({ ok: true });
    expect(
      resolveViewContentContentIds({
        subtype: 'showroom_general',
        unitId: 'u1',
        contentIds: null,
      }),
    ).toBeUndefined();
  });

  it('ViewContent detalle_unidad exige unit_id', () => {
    expect(gateViewContent({ subtype: 'detalle_unidad' }).ok).toBe(false);
    expect(
      gateViewContent({ subtype: 'detalle_unidad', unitId: 'u1' }),
    ).toEqual({ ok: true });
  });

  it('AddToWishlist website + lead + unit', () => {
    expect(
      gateAddToWishlist({
        actionSource: 'website',
        leadId: 'l1',
        unitId: 'u1',
      }),
    ).toEqual({ ok: true });
    expect(
      gateAddToWishlist({
        actionSource: 'business_messaging',
        leadId: 'l1',
        unitId: 'u1',
      }).ok,
    ).toBe(false);
    expect(
      gateAddToWishlist({ actionSource: 'website', leadId: 'l1' }).ok,
    ).toBe(false);
  });

  it('Purchase exige system_generated + currency / value / sale_id', () => {
    expect(
      gatePurchase({
        actionSource: 'system_generated',
        saleId: 's1',
        leadId: 'l1',
        unitId: 'u1',
        value: 100,
        currency: 'USD',
      }),
    ).toEqual({ ok: true });
    expect(
      gatePurchase({
        actionSource: 'website',
        saleId: 's1',
        leadId: 'l1',
        unitId: 'u1',
        value: 100,
        currency: 'USD',
      }).reason,
    ).toBe('purchase_system_generated_crm_only');
    expect(
      gatePurchase({
        actionSource: 'system_generated',
        saleId: 's1',
        leadId: 'l1',
        unitId: 'u1',
        value: 100,
        currency: null,
      }).reason,
    ).toBe('purchase_currency_required_iso4217');
    expect(
      gatePurchase({
        actionSource: 'system_generated',
        saleId: 's1',
        leadId: 'l1',
        unitId: 'u1',
        value: 0,
        currency: 'USD',
      }).reason,
    ).toBe('purchase_value_required');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('$')).toBeNull();
  });
});

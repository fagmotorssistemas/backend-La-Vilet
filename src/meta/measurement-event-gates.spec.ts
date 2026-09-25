import {
  gateAddToWishlist,
  gateHomeListingContent,
  gatePurchase,
  gateViewContent,
  normalizeCurrency,
  resolveHomeListingContent,
  resolveViewContentContentIds,
} from './measurement-event-gates';

describe('measurement-event-gates', () => {
  const unitId = 'a974716f-fd87-4cd7-aaa7-a7793a33fb3b';

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

  it('resolveHomeListingContent no inventa en showroom_general', () => {
    expect(
      resolveHomeListingContent({
        subtype: 'showroom_general',
        unitId,
        contentIds: null,
      }),
    ).toEqual({ contentType: undefined, contentIds: undefined });
  });

  it('resolveHomeListingContent deriva home_listing desde unit_id', () => {
    expect(
      resolveHomeListingContent({
        subtype: 'detalle_unidad',
        unitId,
        contentIds: null,
      }),
    ).toEqual({ contentType: 'home_listing', contentIds: [unitId] });
    expect(
      resolveHomeListingContent({
        subtype: 'favorito',
        unitId,
        contentIds: null,
      }),
    ).toEqual({ contentType: 'home_listing', contentIds: [unitId] });
    expect(
      resolveHomeListingContent({
        unitId,
        contentIds: null,
      }),
    ).toEqual({ contentType: 'home_listing', contentIds: [unitId] });
  });

  it('resolveHomeListingContent conserva ids del productor para el gate', () => {
    expect(
      resolveHomeListingContent({
        unitId,
        contentIds: ['other-id'],
        contentType: 'home_listing',
      }),
    ).toEqual({
      contentType: 'home_listing',
      contentIds: ['other-id'],
    });
  });

  it('home_listing exige exactamente el units.id explícito', () => {
    expect(
      gateHomeListingContent({
        contentType: 'home_listing',
        contentIds: [unitId],
        unitId,
      }),
    ).toEqual({ ok: true });
    expect(
      gateHomeListingContent({
        contentType: 'home_listing',
        contentIds: undefined,
        unitId,
      }).reason,
    ).toBe('home_listing_content_ids_must_match_unit_id');
    expect(
      gateHomeListingContent({
        contentType: 'home_listing',
        contentIds: [unitId],
        unitId: null,
      }).reason,
    ).toBe('home_listing_unit_id_required');
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

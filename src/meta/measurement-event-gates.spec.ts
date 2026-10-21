import {
  gateAddToWishlist,
  gateHomeListingContent,
  gateInitiateCheckout,
  gateQualifiedPurchase,
  gateSale,
  gateSearch,
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
      }),
    ).toEqual({
      ok: false,
      reason: 'home_listing_content_ids_must_match_unit_id',
    });
    expect(
      gateHomeListingContent({
        contentType: 'home_listing',
        contentIds: [unitId],
        unitId: null,
      }),
    ).toEqual({ ok: false, reason: 'home_listing_unit_id_required' });
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

  it('VentaCerrada (venta real) exige system_generated + currency / value / sale_id', () => {
    const base = {
      actionSource: 'system_generated',
      saleId: 's1',
      leadId: 'l1',
      unitId: 'u1',
      value: 100,
      currency: 'USD',
    };
    expect(gateSale(base)).toEqual({ ok: true });
    expect(gateSale({ ...base, actionSource: 'website' })).toEqual({
      ok: false,
      reason: 'sale_system_generated_crm_only',
    });
    expect(gateSale({ ...base, saleId: '' })).toEqual({
      ok: false,
      reason: 'sale_sale_id_required',
    });
    expect(gateSale({ ...base, unitId: null })).toEqual({
      ok: false,
      reason: 'sale_unit_id_required',
    });
    expect(gateSale({ ...base, currency: null })).toEqual({
      ok: false,
      reason: 'sale_currency_required_iso4217',
    });
    expect(gateSale({ ...base, value: 0 })).toEqual({
      ok: false,
      reason: 'sale_value_required',
    });
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('$')).toBeNull();
  });

  it('Purchase = contacto calificado: web o WhatsApp, con lead', () => {
    expect(
      gateQualifiedPurchase({ actionSource: 'website', leadId: 'l1' }),
    ).toEqual({ ok: true });
    expect(
      gateQualifiedPurchase({
        actionSource: 'business_messaging',
        leadId: 'l1',
      }),
    ).toEqual({ ok: true });
    expect(
      gateQualifiedPurchase({ actionSource: 'system_generated', leadId: 'l1' }),
    ).toEqual({
      ok: false,
      reason: 'purchase_is_qualified_contact_use_venta_cerrada',
    });
    expect(
      gateQualifiedPurchase({ actionSource: 'chat', leadId: 'l1' }),
    ).toEqual({ ok: false, reason: 'purchase_website_or_whatsapp_only' });
    expect(
      gateQualifiedPurchase({ actionSource: 'website', leadId: null }),
    ).toEqual({ ok: false, reason: 'purchase_lead_id_required' });
  });

  it('InitiateCheckout exige unidad y canal web o WhatsApp', () => {
    expect(
      gateInitiateCheckout({ actionSource: 'website', unitId: unitId }),
    ).toEqual({ ok: true });
    expect(
      gateInitiateCheckout({ actionSource: 'business_messaging', unitId }),
    ).toEqual({ ok: true });
    expect(
      gateInitiateCheckout({ actionSource: 'website', unitId: null }),
    ).toEqual({ ok: false, reason: 'initiate_checkout_unit_id_required' });
    expect(
      gateInitiateCheckout({ actionSource: 'system_generated', unitId }),
    ).toEqual({
      ok: false,
      reason: 'initiate_checkout_website_or_whatsapp_only',
    });
  });

  it('Search: solo web, con 1 a 10 unidades del listado', () => {
    expect(
      gateSearch({ actionSource: 'website', contentIds: [unitId] }),
    ).toEqual({ ok: true });
    expect(gateSearch({ actionSource: 'website', contentIds: [] })).toEqual({
      ok: false,
      reason: 'search_content_ids_required',
    });
    expect(
      gateSearch({
        actionSource: 'website',
        contentIds: Array.from({ length: 11 }, (_, i) => `u${i}`),
      }),
    ).toEqual({ ok: false, reason: 'search_too_many_content_ids' });
    expect(
      gateSearch({ actionSource: 'business_messaging', contentIds: [unitId] }),
    ).toEqual({ ok: false, reason: 'search_website_only' });
    expect(
      resolveHomeListingContent({
        eventName: 'Search',
        contentIds: [unitId, unitId, ' '],
      }),
    ).toEqual({ contentType: 'home_listing', contentIds: [unitId] });
    expect(
      gateHomeListingContent({
        eventName: 'Search',
        contentType: 'home_listing',
        contentIds: [unitId, 'otra'],
        unitId: null,
      }),
    ).toEqual({ ok: true });
  });
});

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EnqueueEventDto } from './dto/enqueue-event.dto';
import {
  gateAddToWishlist,
  gateQualifiedPurchase,
  gateSale,
  gateViewContent,
} from '../meta/measurement-event-gates';

function validateDto(raw: Record<string, unknown>) {
  const dto = plainToInstance(EnqueueEventDto, raw);
  return {
    dto,
    errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }),
  };
}

describe('measurement enqueue allowlist + gates', () => {
  const base = {
    idempotency_key: 'k1',
    action_source: 'website',
    ads_consent: true,
    event_id: '11111111-1111-4111-8111-111111111111',
  };

  it('acepta los eventos del contrato en el DTO', () => {
    for (const event_name of [
      'AddToWishlist',
      'Purchase',
      'ViewContent',
      'Search',
      'InitiateCheckout',
      'VentaCerrada',
    ]) {
      const { errors } = validateDto({ ...base, event_name });
      expect(errors.filter((e) => e.property === 'event_name')).toHaveLength(0);
    }
  });

  it('rechaza eventos fuera del contrato', () => {
    const { errors } = validateDto({ ...base, event_name: 'AddToCart' });
    expect(errors.some((e) => e.property === 'event_name')).toBe(true);
  });

  it('ViewContent showroom_general ok sin unit; detalle exige unit', () => {
    expect(gateViewContent({ subtype: 'showroom_general' }).ok).toBe(true);
    expect(gateViewContent({ subtype: 'detalle_unidad' }).ok).toBe(false);
    expect(
      gateViewContent({ subtype: 'detalle_unidad', unitId: base.event_id }).ok,
    ).toBe(true);
  });

  it('Wishlist / Purchase / VentaCerrada gates', () => {
    expect(
      gateAddToWishlist({
        actionSource: 'website',
        leadId: base.event_id,
        unitId: base.event_id,
      }).ok,
    ).toBe(true);
    expect(
      gateSale({
        actionSource: 'system_generated',
        saleId: base.event_id,
        leadId: base.event_id,
        unitId: base.event_id,
        value: 10,
        currency: null,
      }),
    ).toEqual({ ok: false, reason: 'sale_currency_required_iso4217' });
    expect(
      gateQualifiedPurchase({
        actionSource: 'system_generated',
        leadId: base.event_id,
      }),
    ).toEqual({
      ok: false,
      reason: 'purchase_is_qualified_contact_use_venta_cerrada',
    });
  });
});

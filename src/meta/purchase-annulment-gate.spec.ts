import {
  decidePurchaseAnnulment,
  saleIdFromPurchaseRow,
} from './purchase-annulment-gate'

describe('purchase annulment gate', () => {
  it('cancela si contrato anulado y aún no enviado', () => {
    expect(
      decidePurchaseAnnulment({
        saleId: 'sale-1',
        contractId: 'c1',
        contractStatus: 'anulado',
        nestAlreadyAccepted: false,
      }),
    ).toEqual({ action: 'cancel', reason: 'contract_anulado' })
  })

  it('anota si ya fue aceptado por Meta', () => {
    expect(
      decidePurchaseAnnulment({
        saleId: 'sale-1',
        contractId: 'c1',
        contractStatus: 'anulado',
        nestAlreadyAccepted: true,
      }),
    ).toEqual({
      action: 'annotate_after_accept',
      reason: 'annulled_after_meta_accepted',
    })
  })

  it('hold ante fallo transitorio de consulta', () => {
    expect(decidePurchaseAnnulment(null, { lookupFailed: true })).toEqual({
      action: 'hold_retry',
      reason: 'sale_lookup_transient',
    })
  })

  it('permite envío si contrato no anulado', () => {
    expect(
      decidePurchaseAnnulment({
        saleId: 'sale-1',
        contractId: 'c1',
        contractStatus: 'firmado',
        nestAlreadyAccepted: false,
      }),
    ).toEqual({ action: 'allow_send' })
  })

  it('extrae sale_id de idempotency_key', () => {
    expect(
      saleIdFromPurchaseRow({ idempotency_key: 'purchase:abc-123' }),
    ).toBe('abc-123')
  })
})

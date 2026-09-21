import {
  quotePostgrestEqValue,
  waLeadLookupCandidates,
} from './wa-lead-lookup'

describe('waLeadLookupCandidates', () => {
  it('incluye dígitos y variante con + (formato CRM)', () => {
    const c = waLeadLookupCandidates('593987077120', '593987077120')
    expect(c).toEqual(
      expect.arrayContaining(['593987077120', '+593987077120']),
    )
  })

  it('desde raw con + también genera dígitos', () => {
    const c = waLeadLookupCandidates(null, '+593987077120')
    expect(c).toEqual(
      expect.arrayContaining(['+593987077120', '593987077120']),
    )
  })
})

describe('quotePostgrestEqValue', () => {
  it('envuelve en comillas para preservar +', () => {
    expect(quotePostgrestEqValue('+593987077120')).toBe('"+593987077120"')
  })
})

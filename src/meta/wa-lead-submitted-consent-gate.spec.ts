import { decideWaLeadSubmittedConsentGate } from './wa-lead-submitted-consent-gate';

describe('decideWaLeadSubmittedConsentGate', () => {
  const scoped = {
    queryOk: true,
    leadFound: true,
    metaAdsConsent: true as boolean | null,
    leadTenantId: 't1',
    leadProjectId: 'p1',
    eventTenantId: 't1',
    eventProjectId: 'p1',
    eventContactId: '4429474',
  };

  it('true autoriza el envío', () => {
    expect(decideWaLeadSubmittedConsentGate(scoped).action).toBe('allow_send');
  });

  it('false cancela (revocado)', () => {
    const d = decideWaLeadSubmittedConsentGate({
      ...scoped,
      metaAdsConsent: false,
    });
    expect(d.action).toBe('cancel_revoked');
    expect(d.reason).toBe('ads_consent_false');
  });

  it('null / undefined permiten envío (configuración operativa)', () => {
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        metaAdsConsent: null,
      }).action,
    ).toBe('allow_send');
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        metaAdsConsent: undefined,
      }).action,
    ).toBe('allow_send');
  });

  it('lead ausente o error de consulta → hold_pending', () => {
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        leadFound: false,
      }).action,
    ).toBe('hold_pending');
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        queryOk: false,
      }).reason,
    ).toBe('ads_consent_query_error');
  });

  it('exige contacto y valida tenant/proyecto', () => {
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        eventContactId: null,
      }).reason,
    ).toBe('contact_scope_required');
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        eventTenantId: 'other',
      }).reason,
    ).toBe('tenant_scope_mismatch');
    expect(
      decideWaLeadSubmittedConsentGate({
        ...scoped,
        eventProjectId: 'other',
      }).reason,
    ).toBe('project_scope_mismatch');
  });

  it('scope omitido en evento no fuerza mismatch (lead puede aportar)', () => {
    const d = decideWaLeadSubmittedConsentGate({
      ...scoped,
      eventTenantId: null,
      eventProjectId: null,
    });
    expect(d.action).toBe('allow_send');
  });
});

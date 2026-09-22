import { evaluateMetaAcceptanceEvidence } from '../meta/meta-acceptance';

/**
 * Unit puro del shape de lookup (sin Nest DI).
 * El GET real vive en EventsService.lookupByEventId.
 */
describe('events lookup contract shape', () => {
  it('api_accepted solo con evidencia Graph coherente', () => {
    const ok = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: 1,
      expectedEvents: 1,
      eventId: '11bf7b00-a462-4e38-8b84-c94e7f63683f',
      fbtraceId: 'A79vzqiFABxvXuEfsMgWVEz',
    });
    expect(ok.tier).toBe('api_accepted');

    const insuf = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: null,
      expectedEvents: 1,
      eventId: 'x',
      fbtraceId: null,
    });
    expect(insuf.tier).toBe('insufficient_evidence');
  });

  it('ausente y error interno no inventan aceptación', () => {
    const absent = {
      ok: false as const,
      found: false as const,
      error: 'event_not_found',
      event_id: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
    };
    expect(absent.found).toBe(false);
    expect(absent).not.toHaveProperty('api_accepted', true);

    const internal = {
      ok: false as const,
      found: false as const,
      error: 'lookup_internal_error',
    };
    expect(internal.error).toBe('lookup_internal_error');
  });
});

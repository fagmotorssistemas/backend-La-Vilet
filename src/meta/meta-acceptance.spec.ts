import {
  countGraphPayloadEvents,
  evaluateMetaAcceptanceEvidence,
} from './meta-acceptance';

describe('evaluateMetaAcceptanceEvidence', () => {
  it('exige events_received > 0 y no solo fbtrace', () => {
    const r = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: null,
      expectedEvents: 1,
      eventId: 'e1',
      fbtraceId: 'TRACE',
    });
    expect(r.tier).toBe('insufficient_evidence');
    expect(r.reason).toBe('events_received_missing_or_zero');
  });

  it('acepta Graph OK + received=1 sin exigir fbtrace', () => {
    const r = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: 1,
      expectedEvents: 1,
      eventId: 'e1',
      fbtraceId: null,
    });
    expect(r.tier).toBe('api_accepted');
    expect(r.correlated).toBe(true);
    expect(r.fbtraceId).toBeNull();
  });

  it('lote N=2 con received=1 no atribuye aceptación', () => {
    const r = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: 1,
      expectedEvents: 2,
      eventId: 'e1',
      fbtraceId: 'TRACE',
    });
    expect(r.tier).toBe('insufficient_evidence');
    expect(r.reason).toBe('events_received_batch_mismatch');
  });

  it('envío unitario acepta received>=1 sin fbtrace', () => {
    const r = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      eventsReceived: 1,
      expectedEvents: 1,
      eventId: 'e1',
      fbtraceId: null,
    });
    expect(r.tier).toBe('api_accepted');
    expect(r.correlated).toBe(true);
  });

  it('rechaza error Graph aunque haya events_received', () => {
    const r = evaluateMetaAcceptanceEvidence({
      httpOk: true,
      httpStatus: 200,
      error: { message: 'fail' },
      eventsReceived: 1,
      expectedEvents: 1,
      eventId: 'e1',
      fbtraceId: 'TRACE',
    });
    expect(r.tier).toBe('api_rejected');
  });

  it('countGraphPayloadEvents lee data[]', () => {
    expect(countGraphPayloadEvents({ data: [{}, {}] })).toBe(2);
    expect(countGraphPayloadEvents({})).toBe(0);
  });
});

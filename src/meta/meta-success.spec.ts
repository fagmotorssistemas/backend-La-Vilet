import { isMetaSendSuccess } from './meta-success';

describe('isMetaSendSuccess', () => {
  it('exige events_received > 0', () => {
    expect(
      isMetaSendSuccess({ httpOk: true, eventsReceived: 0 }),
    ).toBe(false);
    expect(
      isMetaSendSuccess({ httpOk: true, eventsReceived: null }),
    ).toBe(false);
    expect(
      isMetaSendSuccess({ httpOk: true, eventsReceived: 1 }),
    ).toBe(true);
  });

  it('rechaza error de Graph aunque haya events_received', () => {
    expect(
      isMetaSendSuccess({
        httpOk: true,
        error: { message: 'x' },
        eventsReceived: 1,
      }),
    ).toBe(false);
  });
});

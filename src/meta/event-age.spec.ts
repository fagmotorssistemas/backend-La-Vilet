import { isEventTimeTooOld, META_MAX_EVENT_AGE_SEC } from './event-age';

describe('isEventTimeTooOld', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const nowSec = Math.floor(now / 1000);

  it('8 días → vencido', () => {
    expect(isEventTimeTooOld(nowSec - 8 * 86400, now)).toBe(true);
  });

  it('6 días → vigente', () => {
    expect(isEventTimeTooOld(nowSec - 6 * 86400, now)).toBe(false);
  });

  it('justo en el límite → vigente; un segundo después → vencido', () => {
    expect(isEventTimeTooOld(nowSec - META_MAX_EVENT_AGE_SEC, now)).toBe(false);
    expect(isEventTimeTooOld(nowSec - META_MAX_EVENT_AGE_SEC - 1, now)).toBe(
      true,
    );
  });

  it('valores inválidos no se consideran vencidos', () => {
    expect(isEventTimeTooOld(undefined, now)).toBe(false);
    expect(isEventTimeTooOld(0, now)).toBe(false);
    expect(isEventTimeTooOld('x', now)).toBe(false);
  });
});

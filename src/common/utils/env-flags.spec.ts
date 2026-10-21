import { parseBoolFlag } from './env-flags';

describe('parseBoolFlag', () => {
  it.each(['true', 'TRUE', ' 1 ', 'yes', 'on'])('%s → true', (value) => {
    expect(parseBoolFlag(value)).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'OFF'])('%s → false', (value) => {
    expect(parseBoolFlag(value, true)).toBe(false);
  });

  it('vacío o desconocido usa el valor por defecto', () => {
    expect(parseBoolFlag(undefined)).toBe(false);
    expect(parseBoolFlag('', true)).toBe(true);
    expect(parseBoolFlag('tru')).toBe(false);
    expect(parseBoolFlag('tru', true)).toBe(true);
    expect(parseBoolFlag({})).toBe(false);
  });

  it('acepta booleanos y números', () => {
    expect(parseBoolFlag(true)).toBe(true);
    expect(parseBoolFlag(false, true)).toBe(false);
    expect(parseBoolFlag(1)).toBe(true);
    expect(parseBoolFlag(0, true)).toBe(false);
  });
});

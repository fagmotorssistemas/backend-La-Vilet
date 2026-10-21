const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Lee un interruptor de entorno con una sola regla para todo el servicio
 * (worker, drain, health): true|1|yes|on y false|0|no|off, sin distinguir
 * mayúsculas. Vacío o valor no reconocido → `defaultValue`.
 */
export function parseBoolFlag(raw: unknown, defaultValue = false): boolean {
  if (typeof raw === 'boolean') return raw;
  const value =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

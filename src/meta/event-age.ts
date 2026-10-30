/**
 * Meta rechaza (la petición entera) eventos con event_time de más de 7 días.
 * Margen de 1 h para que un evento no venza entre la revisión y el envío.
 * Nunca se cambia event_time para "salvar" un evento: se descarta con motivo.
 */
export const META_MAX_EVENT_AGE_SEC = 7 * 24 * 60 * 60 - 60 * 60;

export const EVENT_TIME_TOO_OLD = 'event_time_too_old';

export function isEventTimeTooOld(
  eventTime: unknown,
  nowMs: number = Date.now(),
): boolean {
  const t = Number(eventTime);
  if (!Number.isFinite(t) || t <= 0) return false;
  return Math.floor(nowMs / 1000) - t > META_MAX_EVENT_AGE_SEC;
}

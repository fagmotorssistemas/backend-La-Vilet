/**
 * Evidencia de aceptación Graph CAPI.
 * fbtrace_id solo no basta: hace falta HTTP OK, sin error Graph y events_received
 * coherente con el tamaño del lote enviado. Events Manager es capa distinta.
 */

export type MetaAcceptanceTier =
  | 'api_accepted'
  | 'api_rejected'
  | 'insufficient_evidence';

export type MetaAcceptanceEvidence = {
  tier: MetaAcceptanceTier;
  correlated: boolean;
  reason: string | null;
  eventsReceived: number | null;
  expectedEvents: number;
  httpStatus: number;
  fbtraceId: string | null;
  eventId: string | null;
};

export function countGraphPayloadEvents(
  payload: Record<string, unknown> | null | undefined,
): number {
  const data = payload?.data;
  if (!Array.isArray(data)) return 0;
  return data.length;
}

/**
 * Criterio de aceptación API (no Events Manager).
 * - Lotes: solo api_accepted si events_received === expectedEvents (o >=1 y expected=1).
 * - No atribuye aceptación individual si el lote tiene N>1 y received≠N.
 * - fbtrace_id es opcional de correlación; no es condición de éxito.
 */
export function evaluateMetaAcceptanceEvidence(input: {
  httpOk: boolean;
  httpStatus: number;
  error?: unknown;
  eventsReceived: number | null;
  expectedEvents: number;
  eventId: string | null | undefined;
  fbtraceId: string | null | undefined;
}): MetaAcceptanceEvidence {
  const expected = Math.max(0, Number(input.expectedEvents) || 0);
  const received = input.eventsReceived;
  const eventId =
    typeof input.eventId === 'string' && input.eventId.trim()
      ? input.eventId.trim()
      : null;
  const fbtraceId =
    typeof input.fbtraceId === 'string' && input.fbtraceId.trim()
      ? input.fbtraceId.trim()
      : null;

  const base = {
    eventsReceived: received,
    expectedEvents: expected,
    httpStatus: input.httpStatus,
    fbtraceId,
    eventId,
  };

  if (!input.httpOk || input.error) {
    return {
      ...base,
      tier: 'api_rejected',
      correlated: false,
      reason: 'graph_http_or_error',
    };
  }

  if (received === null || received <= 0) {
    return {
      ...base,
      tier: 'insufficient_evidence',
      correlated: false,
      reason: 'events_received_missing_or_zero',
    };
  }

  if (expected <= 0) {
    return {
      ...base,
      tier: 'insufficient_evidence',
      correlated: false,
      reason: 'expected_events_unknown',
    };
  }

  // Lote multi-evento: solo aceptar si received === expected (no atribución parcial).
  if (expected > 1 && received !== expected) {
    return {
      ...base,
      tier: 'insufficient_evidence',
      correlated: Boolean(eventId),
      reason: 'events_received_batch_mismatch',
    };
  }

  // Envío unitario (nuestro caso): received >= 1 basta; no exigir fbtrace.
  if (expected === 1 && received < 1) {
    return {
      ...base,
      tier: 'insufficient_evidence',
      correlated: false,
      reason: 'events_received_missing_or_zero',
    };
  }

  return {
    ...base,
    tier: 'api_accepted',
    correlated: Boolean(eventId),
    reason: null,
  };
}

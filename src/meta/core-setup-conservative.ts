/**
 * Modo conservador para Meta Core Setup / configuración básica:
 * - Sin custom_data (incl. content_ids / content_name / content_category)
 * - event_source_url limitado al origen (scheme + host [+ port]), sin path/query/hash
 *
 * Funciones puras: aplicables al construir y justo antes de Graph (cola antigua).
 */

export function originOnlyEventSourceUrl(
  raw?: string | null,
): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

type GraphEvent = Record<string, unknown>;

/**
 * Mutates/clones a Graph CAPI body `{ data: [event, ...] }` under core-setup rules.
 */
export function applyCoreSetupConservativeToGraphBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) {
    delete out.custom_data;
    return out;
  }

  out.data = data.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const event = { ...(item as GraphEvent) };
    delete event.custom_data;
    if (typeof event.event_source_url === 'string') {
      const origin = originOnlyEventSourceUrl(event.event_source_url);
      if (origin) event.event_source_url = origin;
      else delete event.event_source_url;
    }
    return event;
  });

  return out;
}

export function isCoreSetupConservativeEnabled(
  raw: string | undefined | null,
): boolean {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  // Default ON: configuración básica exige no enviar custom_data / path.
  if (!v) return true;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

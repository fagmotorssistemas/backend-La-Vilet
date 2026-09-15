/** Criterio estricto de éxito Graph CAPI. */
export function isMetaSendSuccess(input: {
  httpOk: boolean;
  error?: unknown;
  eventsReceived: number | null;
}): boolean {
  return (
    input.httpOk &&
    !input.error &&
    input.eventsReceived !== null &&
    input.eventsReceived > 0
  );
}

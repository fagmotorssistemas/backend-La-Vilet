/**
 * Flags del receptor Cloud API WhatsApp (vía A / co-suscripción).
 *
 * - CHALLENGE: permite GET hub.verify (Meta App Dashboard) antes de suscribir.
 * - RECEIVE: persiste mensajes; si está OFF, POST no devuelve 200 descartando
 *   en silencio — responde 503 receive_disabled (tras validar firma si aplica).
 */
export function isTruthyEnv(raw: unknown): boolean {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'true'
}

export type WaCloudWebhookFlags = {
  challengeEnabled: boolean
  receiveEnabled: boolean
}

export function resolveWaCloudWebhookFlags(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WaCloudWebhookFlags {
  return {
    challengeEnabled: isTruthyEnv(env.META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED),
    receiveEnabled: isTruthyEnv(env.META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED),
  }
}

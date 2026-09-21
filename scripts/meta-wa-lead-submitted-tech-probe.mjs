#!/usr/bin/env node
/**
 * Prueba técnica aislada LeadSubmitted → dataset WhatsApp 4419657838288963.
 *
 * Oficial CAPI BM: LeadSubmitted + action_source=business_messaging +
 * messaging_channel=whatsapp + user_data.ctwa_clid + WABA + test_event_code.
 * Transporte: POST Graph directo (no outbox Nest; delivery WA permanece OFF).
 *
 * Uso (Droplet o local con .env):
 *   node scripts/meta-wa-lead-submitted-tech-probe.mjs          # dry-run
 *   META_WA_BM_TEST_SEND=1 node scripts/meta-wa-lead-submitted-tech-probe.mjs
 *
 * Requiere:
 *   META_WA_CAPI_ACCESS_TOKEN
 *   META_WA_BM_TEST_CTWA_CLID   (clid técnico ya validado; no inventar / no Pablo comercial)
 *   META_WA_BM_TEST_EVENT_CODE (Events Manager → dataset mensajería → Probar eventos)
 *
 * No imprime tokens ni ctwa_clid completo.
 */
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const DATASET_ID = '4419657838288963'
const WABA_ID = '1410020224338488'
const WEB_DATASET_ID = '923439043758658'
const API_VERSION = 'v26.0'
const EVENT_NAME = 'LeadSubmitted'

function loadEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    let v = line.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function sha12(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 12)
}

function mask(s) {
  const t = String(s || '')
  if (!t) return null
  return { len: t.length, sha12: sha12(t) }
}

const env = {
  ...loadEnvFile(join(root, '.env')),
  ...loadEnvFile(join(root, '.env.local')),
  ...loadEnvFile(join(root, '.env.meta-wa-readonly.local')),
  ...process.env,
}

const send =
  String(env.META_WA_BM_TEST_SEND || '').trim() === '1' ||
  process.argv.includes('--send')

const waToken = String(env.META_WA_CAPI_ACCESS_TOKEN || '').trim()
const webToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()
const ctwaClid = String(env.META_WA_BM_TEST_CTWA_CLID || '').trim()
const testEventCode = String(env.META_WA_BM_TEST_EVENT_CODE || '').trim()
const deliveryOn =
  String(env.META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED || '')
    .trim()
    .toLowerCase() === 'true'

const eventId = randomUUID()
const eventTime = Math.floor(Date.now() / 1000)

const gaps = []
if (!waToken) gaps.push('missing_META_WA_CAPI_ACCESS_TOKEN')
if (waToken && webToken && waToken === webToken) {
  gaps.push('WA_token_must_differ_from_web_token')
}
if (!ctwaClid) gaps.push('missing_META_WA_BM_TEST_CTWA_CLID')
if (!testEventCode) {
  gaps.push(
    'missing_META_WA_BM_TEST_EVENT_CODE — obtener en Events Manager → Data Sources → dataset 4419657838288963 → Probar eventos',
  )
}
if (deliveryOn) {
  gaps.push('META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED_must_stay_false')
}
if (DATASET_ID === WEB_DATASET_ID || DATASET_ID === WABA_ID) {
  gaps.push('invalid_dataset_id')
}

const payload =
  ctwaClid && testEventCode
    ? {
        data: [
          {
            event_name: EVENT_NAME,
            event_time: eventTime,
            event_id: eventId,
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: {
              whatsapp_business_account_id: WABA_ID,
              ctwa_clid: ctwaClid,
            },
          },
        ],
        test_event_code: testEventCode,
      }
    : null

const report = {
  mode: send ? 'SEND' : 'DRY_RUN',
  prepared_at: new Date().toISOString(),
  transport: 'independent_graph_post',
  delivery_wa_remains_off: !deliveryOn,
  official_event: EVENT_NAME,
  graph: {
    method: 'POST',
    url: `https://graph.facebook.com/${API_VERSION}/${DATASET_ID}/events`,
    credential: 'META_WA_CAPI_ACCESS_TOKEN',
  },
  identifiers: {
    messaging_dataset_id: DATASET_ID,
    waba_id: WABA_ID,
    event_name: EVENT_NAME,
    event_id: eventId,
    event_time: eventTime,
    test_event_code_present: Boolean(testEventCode),
    test_event_code_mask: testEventCode ? mask(testEventCode) : null,
    ctwa_clid_mask: ctwaClid ? mask(ctwaClid) : null,
  },
  credentials: {
    wa_token: mask(waToken),
    tokens_distinct: Boolean(waToken && webToken && waToken !== webToken),
  },
  gaps,
  payload_shape: payload
    ? {
        data: [
          {
            event_name: EVENT_NAME,
            event_id: eventId,
            event_time: eventTime,
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: {
              whatsapp_business_account_id: WABA_ID,
              ctwa_clid: `<redacted sha12=${sha12(ctwaClid)}>`,
            },
          },
        ],
        test_event_code: `<redacted sha12=${sha12(testEventCode)}>`,
      }
    : null,
  verify_in_events_manager: [
    `Events Manager → Data Sources → dataset ${DATASET_ID} → Probar eventos`,
    'Tras HTTP 200 + events_received>=1, el LeadSubmitted debe aparecer en la ventana de prueba (no basta conqueued en Nest).',
  ],
  distinction: {
    technical_send:
      'POST Graph con test_event_code + clid técnico → aceptación Meta',
    commercial_attribution_pending:
      'Inbound real con ctwa_clid + consentimiento + enqueue FE LeadSubmitted + delivery ON',
  },
}

if (!send || gaps.length) {
  console.log(JSON.stringify({ ...report, sent: false }, null, 2))
  process.exitCode = gaps.length ? 2 : 0
  process.exit()
}

const res = await fetch(report.graph.url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${waToken}`,
  },
  body: JSON.stringify(payload),
})
const body = await res.json().catch(() => ({}))
const eventsReceived =
  typeof body.events_received === 'number' ? body.events_received : null
const fbtrace =
  body.fbtrace_id ||
  body.error?.fbtrace_id ||
  null
const err = body.error
  ? {
      code: body.error.code ?? null,
      subcode: body.error.error_subcode ?? null,
      type: body.error.type ?? null,
      message: String(body.error.message || '')
        .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
        .slice(0, 200),
    }
  : null

const accepted =
  res.status >= 200 &&
  res.status < 300 &&
  eventsReceived != null &&
  eventsReceived >= 1

console.log(
  JSON.stringify(
    {
      ...report,
      sent: true,
      meta: {
        http_status: res.status,
        events_received: eventsReceived,
        fbtrace_id: fbtrace,
        error: err,
        api_accepted: accepted,
      },
      verdict: accepted
        ? 'technical_send_validated_check_probar_eventos_dashboard'
        : 'meta_rejected_or_insufficient_evidence',
    },
    null,
    2,
  ),
)
process.exitCode = accepted ? 0 : 3

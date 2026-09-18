#!/usr/bin/env node
/**
 * Prueba aislada BM → dataset mensajería (no producción).
 *
 * Alineación con captura Graph Explorer exitosa (no docs genéricos):
 * - API v26.0 (solo esta sonda; no cambia META_API_VERSION de Nest/CAPI web)
 * - custom_data: { currency: "USD", value: 100 } (number)
 * - TestEvent + business_messaging + whatsapp + WABA + dataset + TEST9686
 * - ctwa_clid: SOLO el del envío exitoso → META_WA_BM_TEST_CTWA_CLID
 *   (no se usa el sample de la documentación Meta)
 * - sin partner_agent
 *
 * Default: DRY RUN — nuevo event_id + event_time actual; NO POST Meta.
 * Envío: META_WA_BM_TEST_SEND=1 (PowerShell: $env:META_WA_BM_TEST_SEND='1')
 *
 * Transporte: POST Graph independiente (no Nest sendToMeta/outbox/v1/events).
 */
import { createHash, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'review-local')
const planPath = join(outDir, 'META_WA_BM_TEST_PROBE_PLAN.json')
const readyPath = join(outDir, 'META_WA_BM_TEST_PROBE_READY.json')
const diagnosisPath = join(outDir, 'META_WA_BM_TEST_PROBE_DIAGNOSIS.json')
const nextPath = join(outDir, 'META_WA_BM_TEST_PROBE_NEXT.json')

const DATASET_ID = '4419657838288963'
const WABA_ID = '1410020224338488'
const TEST_EVENT_CODE = 'TEST9686'
const WEB_DATASET_ID = '923439043758658'
const EVENT_NAME = 'TestEvent'
/** Solo esta sonda — no mutar Nest META_API_VERSION. */
const PROBE_API_VERSION = 'v26.0'
const REJECTED_EVENT_ID = 'e3851838-e153-4df3-a835-d49b7394130d'
/** Scope CRM local (no bypass is_probe). */
const LAVILET_TENANT_ID = 'a1b2c3d4-0001-4000-8000-000000000001'
const LAVILET_PROJECT_ID = 'b1b2c3d4-0001-4000-8000-000000000001'

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

function assertLocalSupabase(url) {
  if (!url) return 'SUPABASE_URL ausente'
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return 'SUPABASE_URL inválida'
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return `SUPABASE_URL no es local (host=${host}); abortado`
  }
  return null
}

const readonlyLocal = loadEnvFile(join(root, '.env.meta-wa-readonly.local'))
const env = {
  ...loadEnvFile(join(root, '.env')),
  ...readonlyLocal,
  ...process.env,
}

const send =
  String(env.META_WA_BM_TEST_SEND || '').trim() === '1' ||
  process.argv.includes('--send')

const waToken = String(env.META_WA_CAPI_ACCESS_TOKEN || '').trim()
const webToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()
/** Versión Nest global: solo informativa; la sonda usa PROBE_API_VERSION. */
const nestApiVersion = String(env.META_API_VERSION || 'v21.0').trim()
const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '')
const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

/**
 * ctwa_clid del Graph Explorer exitoso — obligatorio.
 * No se asume igualdad con el sample de la documentación Meta.
 */
const ctwaClid = String(env.META_WA_BM_TEST_CTWA_CLID || '').trim()

mkdirSync(outDir, { recursive: true })

/** Siempre nuevo event_id + tiempo actual al preparar; no reutilizar el rechazo. */
let eventId = randomUUID()
let eventTime = Math.floor(Date.now() / 1000)

if (send && existsSync(readyPath)) {
  try {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
    if (
      ready.event_id &&
      /^[0-9a-f-]{36}$/i.test(ready.event_id) &&
      ready.event_id !== REJECTED_EVENT_ID
    ) {
      eventId = ready.event_id
    }
    // event_time siempre al momento del envío (no congelar el del dry-run).
    eventTime = Math.floor(Date.now() / 1000)
  } catch {
    eventTime = Math.floor(Date.now() / 1000)
  }
}

if (eventId === REJECTED_EVENT_ID) {
  eventId = randomUUID()
  eventTime = Math.floor(Date.now() / 1000)
}

const idempotencyKey = `wa_bm_test:${eventId}`

const gaps = []
const localGap = assertLocalSupabase(supabaseUrl)
if (localGap) gaps.push(localGap)
if (!waToken) gaps.push('Falta META_WA_CAPI_ACCESS_TOKEN en Nest .env')
if (waToken && webToken && waToken === webToken) {
  gaps.push('META_WA_CAPI_ACCESS_TOKEN no debe ser igual al token web')
}
if (DATASET_ID === WEB_DATASET_ID) {
  gaps.push('Dataset mensajería no puede ser el pixel web')
}
if (DATASET_ID === WABA_ID) {
  gaps.push('Dataset no puede ser el WABA')
}
if (
  String(env.META_WA_LEAD_SUBMITTED_ENABLED || '').toLowerCase() === 'true' ||
  String(env.META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED || '').toLowerCase() ===
    'true'
) {
  gaps.push(
    'Flags META_WA_LEAD_SUBMITTED_* están en true; deben permanecer false',
  )
}
if (!serviceKey) {
  gaps.push('SUPABASE_SERVICE_ROLE_KEY ausente (bitácora local)')
}
if (!ctwaClid) {
  gaps.push(
    'Falta META_WA_BM_TEST_CTWA_CLID (ctwa_clid exacto del Graph Explorer exitoso). No está en el repo; no se usa el sample de la documentación Meta.',
  )
}

const payload = ctwaClid
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
          custom_data: {
            currency: 'USD',
            value: 100,
          },
        },
      ],
      test_event_code: TEST_EVENT_CODE,
    }
  : null

const transport = {
  type: 'independent_graph_post',
  uses_nest_sendToMeta: false,
  uses_nest_outbox: false,
  uses_nest_v1_events: false,
  reason:
    'Nest /v1/events no admite TestEvent; POST Graph directo con token WA',
}

const comparison = {
  source: 'captura_graph_explorer_exitosa_usuario',
  api_version: {
    graph_explorer_success: 'v26.0',
    probe_failed: 'v21.0',
    probe_prepared_now: PROBE_API_VERSION,
    nest_META_API_VERSION_untouched: nestApiVersion,
  },
  custom_data: {
    graph_explorer_success: { currency: 'USD', value: 100 },
    probe_failed: { currency: 'USD', value: 123 },
    probe_prepared_now: { currency: 'USD', value: 100 },
    value_type: 'number',
  },
  ctwa_clid: {
    graph_explorer_success_captured_in_repo: false,
    note: 'No hay archivo/local con el ctwa_clid del envío exitoso. Pegar en META_WA_BM_TEST_CTWA_CLID (.env.meta-wa-readonly.local). No se presupone el sample de docs Meta.',
    prepared_from_env: Boolean(ctwaClid),
    prepared_mask: ctwaClid ? mask(ctwaClid) : null,
  },
  partner_agent: { probe_failed: 'present', prepared: 'absent' },
  preserved: [
    'TestEvent',
    'business_messaging',
    'whatsapp',
    WABA_ID,
    DATASET_ID,
    TEST_EVENT_CODE,
  ],
}

const plan = {
  mode: send ? 'SEND' : 'DRY_RUN_READY',
  prepared_at: new Date().toISOString(),
  transport,
  comparison,
  graph: {
    method: 'POST',
    url: `https://graph.facebook.com/${PROBE_API_VERSION}/${DATASET_ID}/events`,
    credential: 'META_WA_CAPI_ACCESS_TOKEN',
    web_token_used: false,
    api_version_probe_only: PROBE_API_VERSION,
  },
  identifiers: {
    messaging_dataset_id: DATASET_ID,
    waba_id: WABA_ID,
    web_dataset_id_not_used: WEB_DATASET_ID,
    test_event_code: TEST_EVENT_CODE,
    event_name: EVENT_NAME,
    event_id: eventId,
    event_time: eventTime,
    idempotency_key: idempotencyKey,
    rejected_event_id_preserved: REJECTED_EVENT_ID,
  },
  credentials: {
    wa_token: mask(waToken),
    web_token: mask(webToken),
    tokens_distinct: Boolean(waToken && webToken && waToken !== webToken),
  },
  crm_bitacora: {
    table: 'meta_capi_conversion_log',
    delivery_lane: 'test',
    stages: {
      before_meta: 'enqueued',
      after_meta_ok: 'meta_accepted',
      after_meta_fail: 'meta_rejected',
    },
    error_logging:
      'error_subcode, error_user_title, error_user_msg, error_data, fbtrace_id (desde error.*)',
  },
  production_flags: {
    META_WA_LEAD_SUBMITTED_ENABLED:
      env.META_WA_LEAD_SUBMITTED_ENABLED || 'false',
    META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED:
      env.META_WA_LEAD_SUBMITTED_DELIVERY_ENABLED || 'false',
  },
  gaps,
  payload_redacted: payload
    ? {
        data: [
          {
            ...payload.data[0],
            user_data: {
              whatsapp_business_account_id: WABA_ID,
              ctwa_clid: `<redacted len=${ctwaClid.length} sha12=${sha12(ctwaClid)}>`,
            },
            custom_data: { currency: 'USD', value: 100 },
          },
        ],
        test_event_code: TEST_EVENT_CODE,
      }
    : null,
}

writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8')
writeFileSync(
  readyPath,
  JSON.stringify(
    {
      event_id: eventId,
      event_time: eventTime,
      idempotency_key: idempotencyKey,
      event_name: EVENT_NAME,
      test_event_code: TEST_EVENT_CODE,
      dataset_id: DATASET_ID,
      waba_id: WABA_ID,
      api_version: PROBE_API_VERSION,
      custom_data: { currency: 'USD', value: 100 },
      ctwa_clid_configured: Boolean(ctwaClid),
      ctwa_clid_mask: ctwaClid ? mask(ctwaClid) : null,
      transport: transport.type,
      frozen_for_single_send: true,
      event_time_refreshed_on_send: true,
      rejected_event_id_not_reused: REJECTED_EVENT_ID,
      updated_at: new Date().toISOString(),
    },
    null,
    2,
  ),
  'utf8',
)

writeFileSync(
  diagnosisPath,
  JSON.stringify(
    {
      updated_at: new Date().toISOString(),
      comparison,
      prior_error_recovery:
        'Cuerpo completo del 400 no recuperable sin reenvío; sonda antigua truncó subcode/user_msg/fbtrace.',
      rejected_row: REJECTED_EVENT_ID,
    },
    null,
    2,
  ),
  'utf8',
)

writeFileSync(
  nextPath,
  JSON.stringify(
    {
      status: gaps.length ? 'blocked_by_gaps' : 'prepared_not_sent',
      gaps,
      graph_url: `https://graph.facebook.com/${PROBE_API_VERSION}/${DATASET_ID}/events`,
      body_shape: plan.payload_redacted,
      notes: [
        'Sin partner_agent',
        'value numérico 100',
        'API v26.0 solo en sonda',
        'Nest META_API_VERSION intacto',
        'Rechazo e3851838… intacto',
      ],
    },
    null,
    2,
  ),
  'utf8',
)

console.log(
  JSON.stringify({ ...plan, plan_file: planPath, ready_file: readyPath }, null, 2),
)

async function logCrm(stage, reason, details) {
  const localErr = assertLocalSupabase(supabaseUrl)
  if (localErr) return { ok: false, reason: localErr }
  if (!serviceKey) return { ok: false, reason: 'no_service_key' }
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/lv_log_meta_conversion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      p_stage: stage,
      p_event_name: EVENT_NAME,
      p_reason: reason,
      p_lead_id: null,
      p_contact_id: null,
      p_tenant_id: LAVILET_TENANT_ID,
      p_project_id: LAVILET_PROJECT_ID,
      p_event_id: eventId,
      p_idempotency_key: idempotencyKey,
      p_delivery_lane: 'test',
      p_details: details,
    }),
  })
  const text = await res.text()
  return { ok: res.ok, http: res.status, body: text.slice(0, 200) }
}

if (!send) {
  if (gaps.length) {
    console.error('\nDRY RUN con gaps — no bitácora enqueued ni envío.')
    console.error(gaps.join('\n'))
    console.error(
      '\nAñade a .env.meta-wa-readonly.local:\nMETA_WA_BM_TEST_CTWA_CLID=<ctwa_clid exacto del Graph Explorer exitoso>',
    )
    process.exit(2)
  }
  const pre = await logCrm('enqueued', 'isolated_bm_test_probe', {
    is_probe: true,
    probe_kind: 'isolated_bm_test',
    test_event_code: TEST_EVENT_CODE,
    synthetic_ctwa: true,
    dataset_id: DATASET_ID,
    waba_id: WABA_ID,
    awaiting_meta: true,
    transport: transport.type,
    api_version: PROBE_API_VERSION,
    custom_data_value: 100,
  })
  console.error(
    `\nDRY RUN READY: event_id=${eventId} api=${PROBE_API_VERSION} bitácora_enqueued=${JSON.stringify(pre)}`,
  )
  console.error(
    "Nada enviado. PowerShell: $env:META_WA_BM_TEST_SEND='1'; node scripts/meta-wa-bm-test-probe.mjs",
  )
  process.exit(pre.ok ? 0 : 2)
}

if (gaps.length || !payload) {
  console.error('Abortado SEND por gaps:')
  console.error(gaps.join('\n'))
  process.exit(1)
}

const before = await logCrm('enqueued', 'isolated_bm_test_probe', {
  is_probe: true,
  probe_kind: 'isolated_bm_test',
  test_event_code: TEST_EVENT_CODE,
  synthetic_ctwa: true,
  dataset_id: DATASET_ID,
  waba_id: WABA_ID,
  awaiting_meta: true,
  transport: transport.type,
  api_version: PROBE_API_VERSION,
})

const graphRes = await fetch(
  `https://graph.facebook.com/${PROBE_API_VERSION}/${DATASET_ID}/events`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${waToken}`,
    },
    body: JSON.stringify(payload),
  },
)
const graphBody = await graphRes.json().catch(() => ({}))
const err =
  graphBody && typeof graphBody.error === 'object' && graphBody.error
    ? graphBody.error
    : null
const eventsReceived =
  typeof graphBody.events_received === 'number'
    ? graphBody.events_received
    : null
const fbtrace =
  (typeof err?.fbtrace_id === 'string' && err.fbtrace_id) ||
  (typeof graphBody.fbtrace_id === 'string' && graphBody.fbtrace_id) ||
  null
const graphOk = graphRes.ok && !err && eventsReceived === 1

const errorFull = err
  ? {
      message: typeof err.message === 'string' ? err.message : null,
      type: typeof err.type === 'string' ? err.type : null,
      code: typeof err.code === 'number' ? err.code : null,
      error_subcode:
        typeof err.error_subcode === 'number' ? err.error_subcode : null,
      is_transient:
        typeof err.is_transient === 'boolean' ? err.is_transient : null,
      error_user_title:
        typeof err.error_user_title === 'string' ? err.error_user_title : null,
      error_user_msg:
        typeof err.error_user_msg === 'string' ? err.error_user_msg : null,
      error_data: err.error_data ?? null,
      fbtrace_id: fbtrace,
    }
  : null

const crmDetails = {
  is_probe: true,
  probe_kind: 'isolated_bm_test',
  test_event_code: TEST_EVENT_CODE,
  synthetic_ctwa: true,
  dataset_id: DATASET_ID,
  waba_id: WABA_ID,
  fbtrace_id: fbtrace,
  events_received: eventsReceived,
  http_status: graphRes.status,
  expected_events: 1,
  correlated: Boolean(fbtrace && graphOk),
  acceptance_layer: 'graph_api',
  awaiting_meta: false,
  transport: transport.type,
  api_version: PROBE_API_VERSION,
  error_subcode: errorFull?.error_subcode ?? null,
  error_user_title: errorFull?.error_user_title ?? null,
  error_user_msg: errorFull?.error_user_msg ?? null,
  error_data: errorFull?.error_data ?? null,
  error_type: errorFull?.type ?? null,
  error_code: errorFull?.code ?? null,
}

const after = await logCrm(
  graphOk ? 'meta_accepted' : 'meta_rejected',
  graphOk
    ? null
    : String(
        errorFull?.error_user_msg || errorFull?.message || 'meta_error',
      ).slice(0, 500),
  crmDetails,
)

const result = {
  event_id: eventId,
  event_name: EVENT_NAME,
  api_version: PROBE_API_VERSION,
  transport: transport.type,
  graph_http: graphRes.status,
  graph_ok: graphOk,
  events_received: eventsReceived,
  fbtrace_id: fbtrace,
  crm_before: before,
  crm_after: after,
  error: errorFull,
}
writeFileSync(
  join(outDir, 'META_WA_BM_TEST_PROBE_LAST_RESULT.json'),
  JSON.stringify(result, null, 2),
  'utf8',
)
console.log(JSON.stringify(result, null, 2))
process.exit(graphOk ? 0 : 1)

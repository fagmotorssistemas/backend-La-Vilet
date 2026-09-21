#!/usr/bin/env node
/**
 * Solo lectura EN EL DROPLET (/opt/lavilet-meta-capi).
 *
 * Consulta la suscripción efectiva de webhooks de la app La Vilet
 * (GET /{app-id}/subscriptions) con appsecret_proof.
 *
 * Uso:
 *   cd /opt/lavilet-meta-capi
 *   node scripts/meta-wa-app-subscriptions-on-droplet.mjs
 *
 * Lee .env del directorio de trabajo (Compose lavilet-capi).
 * Nunca imprime tokens, App Secret, firmas ni cuerpos.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = process.env.APP_DIR || path.resolve(__dirname, '..')
const API = process.env.META_GRAPH_API || 'https://graph.facebook.com/v21.0'
const APP = '1576506134490618'
const APP_KOMMO = '1022173854571346'
const WABA = '1410020224338488'
const PHONE = '1372191202637500'
const EXPECTED_HOST = 'capi.lavilett.com'
const EXPECTED_PATH = '/api/whatsapp/webhook'

const TOKEN_CANDIDATES = [
  'META_WA_READONLY_TOKEN',
  'META_WA_GRAPH_TOKEN',
  'META_CAPI_ACCESS_TOKEN',
  'META_WA_CAPI_ACCESS_TOKEN',
]

function loadEnvFile(filePath) {
  const out = {}
  if (!fs.existsSync(filePath)) return out
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 0) continue
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

function loadEnv() {
  const merged = {
    ...loadEnvFile(path.join(APP_DIR, '.env')),
    ...loadEnvFile(path.join(APP_DIR, '.env.local')),
  }
  // process.env gana (Compose inyecta vars)
  for (const k of Object.keys(merged)) {
    if (process.env[k] != null && String(process.env[k]).length) {
      merged[k] = process.env[k]
    }
  }
  for (const k of [
    ...TOKEN_CANDIDATES,
    'META_WA_APP_SECRET',
    'META_WABA_ID',
    'META_WA_PHONE_NUMBER_ID',
  ]) {
    if (process.env[k] != null && String(process.env[k]).length) {
      merged[k] = process.env[k]
    }
  }
  return merged
}

function present(v) {
  return Boolean(String(v || '').trim())
}

function hostPath(urlStr) {
  try {
    const u = new URL(urlStr)
    return { host: u.host, path: u.pathname }
  } catch {
    return { host: null, path: null }
  }
}

function sanitizeError(json) {
  if (!json?.error) return null
  const msg = String(json.error.message || '')
  // Evitar eco accidental de tokens en mensajes Graph
  const scrubbed = msg
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/appsecret_proof=[^&\s]+/gi, 'appsecret_proof=[redacted]')
  return {
    code: json.error.code ?? null,
    subcode: json.error.error_subcode ?? null,
    type: json.error.type ?? null,
    message: scrubbed.slice(0, 240),
  }
}

async function graphGet(token, urlPath, query = {}) {
  const url = new URL(`${API}${urlPath}`)
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).length) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => ({}))
  return { http: res.status, json }
}

function pickToken(env) {
  for (const name of TOKEN_CANDIDATES) {
    if (present(env[name])) return { name, token: String(env[name]).trim() }
  }
  return { name: null, token: null }
}

function appsecretProof(token, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex')
}

function summarizeSubscriptions(data) {
  const rows = Array.isArray(data) ? data : []
  return rows.map((d) => {
    const cb = hostPath(d.callback_url || '')
    const fields = Array.isArray(d.fields)
      ? d.fields
          .map((f) => (typeof f === 'string' ? f : f?.name))
          .filter(Boolean)
          .sort()
      : []
    return {
      object: d.object || null,
      active: d.active ?? null,
      callback_host: cb.host,
      callback_path: cb.path,
      fields,
      // flags de contraste (sin secretos)
      matches_expected_callback:
        cb.host === EXPECTED_HOST && cb.path === EXPECTED_PATH,
      is_whatsapp_business_account: d.object === 'whatsapp_business_account',
      has_messages: fields.includes('messages'),
    }
  })
}

async function main() {
  const env = loadEnv()
  const appSecret = String(env.META_WA_APP_SECRET || '').trim()
  const { name: tokenEnv, token } = pickToken(env)

  const report = {
    checked_at: new Date().toISOString(),
    app_dir: APP_DIR,
    app_id: APP,
    auth: {
      app_secret_present: present(appSecret),
      token_env_used: tokenEnv,
      token_present: present(token),
    },
  }

  if (!present(appSecret)) {
    report.ok = false
    report.error = {
      reason: 'META_WA_APP_SECRET_missing_in_env',
      hint: 'Debe existir en /opt/lavilet-meta-capi/.env (Compose). No pegar el valor en chat.',
    }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }
  if (!present(token)) {
    report.ok = false
    report.error = {
      reason: 'graph_token_missing',
      tried_env: TOKEN_CANDIDATES,
      hint: 'Ninguna de las vars candidatas tiene valor en .env / entorno del contenedor.',
    }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }

  // 1) Validar que el token pertenece a la app La Vilet (sin imprimir token)
  const dbg = await graphGet(token, '/debug_token', { input_token: token })
  const d = dbg.json?.data || {}
  report.debug_token = {
    http: dbg.http,
    error: sanitizeError(dbg.json),
    app_id: d.app_id ? String(d.app_id) : null,
    app_matches_lavilet: String(d.app_id || '') === APP,
    type: d.type || null,
    is_valid: d.is_valid ?? null,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
  }

  if (dbg.http !== 200 || d.is_valid === false) {
    report.ok = false
    report.error = { reason: 'token_invalid_or_debug_failed' }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }
  if (!report.debug_token.app_matches_lavilet) {
    report.ok = false
    report.error = {
      reason: 'token_app_id_mismatch',
      expected_app: APP,
      got_app: report.debug_token.app_id,
      hint: 'El token no es de la app La Vilet; /subscriptions con este token/secret puede fallar o reflejar otra app.',
    }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }

  // 2) Suscripción efectiva de la app (requiere App Secret)
  const proof = appsecretProof(token, appSecret)
  const subs = await graphGet(token, `/${APP}/subscriptions`, {
    appsecret_proof: proof,
  })
  const list = summarizeSubscriptions(subs.json?.data)
  report.app_subscriptions = {
    http: subs.http,
    error: sanitizeError(subs.json),
    subscriptions: list.map((s) => ({
      object: s.object,
      active: s.active,
      callback_host: s.callback_host,
      callback_path: s.callback_path,
      fields: s.fields,
    })),
  }

  const wabaSub = list.find((s) => s.is_whatsapp_business_account) || null
  report.verdict_subscription = {
    has_whatsapp_business_account_object: Boolean(wabaSub),
    active: wabaSub ? wabaSub.active : null,
    has_messages: wabaSub ? wabaSub.has_messages : false,
    callback_matches_nest: wabaSub ? wabaSub.matches_expected_callback : false,
    expected_callback: `https://${EXPECTED_HOST}${EXPECTED_PATH}`,
    matches_all:
      Boolean(wabaSub) &&
      wabaSub.active !== false &&
      wabaSub.has_messages &&
      wabaSub.matches_expected_callback,
  }

  // 3) Si la suscripción de app cuadra, seguir: co-suscripción + callback teléfono + permisos efectivos
  const subApps = await graphGet(token, `/${WABA}/subscribed_apps`)
  const apps = (Array.isArray(subApps.json?.data) ? subApps.json.data : []).map(
    (row) => {
      const wa = row.whatsapp_business_api_data || row
      const override = wa.override_callback_uri || row.override_callback_uri || null
      const ov = override ? hostPath(override) : null
      return {
        id: String(wa.id || ''),
        name: wa.name || null,
        has_override_callback_uri: Boolean(override),
        override_callback_host: ov?.host || null,
        override_callback_path: ov?.path || null,
      }
    },
  )
  const ids = new Set(apps.map((a) => a.id))
  report.waba_subscribed_apps = {
    http: subApps.http,
    error: sanitizeError(subApps.json),
    apps,
    has_lavilet: ids.has(APP),
    has_kommo: ids.has(APP_KOMMO),
    only_these_two: ids.size === 2 && ids.has(APP) && ids.has(APP_KOMMO),
  }

  const phone = await graphGet(token, `/${PHONE}`, {
    fields: 'id,display_phone_number,webhook_configuration',
  })
  const cfg = phone.json?.webhook_configuration || null
  const appCb = cfg?.application ? hostPath(cfg.application) : null
  const phoneOv = cfg?.phone_number ? hostPath(cfg.phone_number) : null
  report.phone_webhook_configuration = {
    http: phone.http,
    error: sanitizeError(phone.json),
    keys: cfg ? Object.keys(cfg) : [],
    application_callback_host: appCb?.host || null,
    application_callback_path: appCb?.path || null,
    application_matches_nest:
      Boolean(appCb) &&
      appCb.host === EXPECTED_HOST &&
      appCb.path === EXPECTED_PATH,
    phone_number_override_present: Boolean(phoneOv),
    phone_number_override_host: phoneOv?.host || null,
    phone_number_override_path: phoneOv?.path || null,
  }

  const waba = await graphGet(token, `/${WABA}`, {
    fields:
      'id,name,account_review_status,business_verification_status,ownership_type',
  })
  report.waba = {
    http: waba.http,
    error: sanitizeError(waba.json),
    id: waba.json?.id || null,
    account_review_status: waba.json?.account_review_status || null,
    business_verification_status: waba.json?.business_verification_status || null,
    ownership_type: waba.json?.ownership_type || null,
  }

  // Permisos / acceso efectivo (sin listar secretos)
  const neededScopes = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
  ]
  const have = new Set(report.debug_token.scopes || [])
  report.permissions_effective = {
    scopes_present: report.debug_token.scopes,
    has_whatsapp_business_management: have.has('whatsapp_business_management'),
    has_whatsapp_business_messaging: have.has('whatsapp_business_messaging'),
    note: 'Recibir webhooks no exige messaging en el token; el fan-out usa callback de la app suscrita. messaging importa para enviar Cloud API, no para ingest.',
  }

  // Gaps / siguientes focos (no declara cerrado solo por Dashboard)
  const gaps = []
  if (subs.http !== 200) gaps.push('app_subscriptions_http_failed')
  if (!report.verdict_subscription.matches_all) {
    if (!report.verdict_subscription.has_whatsapp_business_account_object) {
      gaps.push('missing_object_whatsapp_business_account')
    } else {
      if (report.verdict_subscription.active === false) gaps.push('subscription_inactive')
      if (!report.verdict_subscription.has_messages) gaps.push('messages_field_not_subscribed')
      if (!report.verdict_subscription.callback_matches_nest) {
        gaps.push('callback_mismatch_vs_nest')
      }
    }
  }
  if (!report.waba_subscribed_apps.has_lavilet) gaps.push('lavilet_not_in_waba_subscribed_apps')
  if (!report.waba_subscribed_apps.has_kommo) gaps.push('kommo_missing_keep_intact')
  if (apps.some((a) => a.has_override_callback_uri)) {
    gaps.push('override_callback_uri_present_on_subscribed_app')
  }
  if (report.phone_webhook_configuration.phone_number_override_present) {
    gaps.push('phone_number_callback_override_present')
  }
  if (
    report.verdict_subscription.matches_all &&
    report.waba_subscribed_apps.has_lavilet &&
    report.waba_subscribed_apps.has_kommo
  ) {
    gaps.push(
      'config_looks_aligned_but_production_fanout_unproven__check_meta_webhook_delivery_history',
    )
  }

  report.gaps = gaps
  report.next_readonly_checks = [
    'Meta App Dashboard → WhatsApp → Configuration → Webhook → “Recent deliveries” / failed deliveries para app 1576506134490618 (solo lectura).',
    'Nginx access.log: ¿algún POST /api/whatsapp/webhook en la ventana del inbound real? Si 0 → Meta no intentó Nest (no es rechazo de firma).',
    'Conservar Kommo en subscribed_apps; no DELETE/POST suscripciones en este paso.',
  ]
  report.ok = subs.http === 200 && !report.error

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok || (subs.http !== 200 && !report.verdict_subscription.matches_all)) {
    process.exitCode = subs.http === 200 ? 0 : 3
  }
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      ok: false,
      fatal: e instanceof Error ? e.message : 'error',
      note: 'Sin stack con credenciales',
    }),
  )
  process.exitCode = 1
})

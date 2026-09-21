#!/usr/bin/env node
/**
 * Solo lectura EN EL DROPLET (/opt/lavilet-meta-capi).
 *
 * 1) Inspecciona META_WA_CAPI_ACCESS_TOKEN (app + scopes) sin imprimirlo.
 * 2) GET /{app-id}/subscriptions con **app access token** de la app La Vilet
 *    (requerido por el endpoint: access_token = APP_ID|APP_SECRET).
 *    No usa META_CAPI_ACCESS_TOKEN ni “cualquier token + appsecret_proof”.
 *
 * Uso:
 *   cd /opt/lavilet-meta-capi
 *   node scripts/meta-wa-app-subscriptions-on-droplet.mjs
 *
 * No modifica tokens, suscripciones ni delivery.
 */
import fs from 'fs'
import path from 'path'
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

/** Tokens WA candidatos (NUNCA el CAPI web). */
const WA_TOKEN_CANDIDATES = [
  'META_WA_CAPI_ACCESS_TOKEN',
  'META_WA_READONLY_TOKEN',
  'META_WA_GRAPH_TOKEN',
]

/** Excluido a propósito: pertenece a otra app (CAPI Pixel/web). */
const EXCLUDED_WEB_TOKEN = 'META_CAPI_ACCESS_TOKEN'

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
  for (const k of [
    ...WA_TOKEN_CANDIDATES,
    EXCLUDED_WEB_TOKEN,
    'META_WA_APP_SECRET',
    'META_WABA_ID',
    'META_WA_PHONE_NUMBER_ID',
  ]) {
    if (process.env[k] != null && String(process.env[k]).length) {
      merged[k] = process.env[k]
    } else if (merged[k] == null && process.env[k] != null) {
      merged[k] = process.env[k]
    }
  }
  // process.env gana para keys ya en merged
  for (const k of Object.keys(merged)) {
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
  const scrubbed = msg
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/appsecret_proof=[^&\s]+/gi, 'appsecret_proof=[redacted]')
    .replace(/\d{15,}\|[^&\s]+/g, '[app-access-token-redacted]')
  return {
    code: json.error.code ?? null,
    subcode: json.error.error_subcode ?? null,
    type: json.error.type ?? null,
    message: scrubbed.slice(0, 240),
  }
}

/**
 * GET Graph. El token va solo en Authorization (nunca en logs de URL).
 */
async function graphGet(accessToken, urlPath, query = {}) {
  const url = new URL(`${API}${urlPath}`)
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).length) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await res.json().catch(() => ({}))
  return { http: res.status, json }
}

async function debugToken(inspectorToken, inputToken) {
  // debug_token: input_token en query; usamos inspector como Bearer
  return graphGet(inspectorToken, '/debug_token', { input_token: inputToken })
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
      matches_expected_callback:
        cb.host === EXPECTED_HOST && cb.path === EXPECTED_PATH,
      is_whatsapp_business_account: d.object === 'whatsapp_business_account',
      has_messages: fields.includes('messages'),
    }
  })
}

/**
 * App access token de La Vilet: APP_ID|APP_SECRET.
 * Meta: GET /{app-id}/subscriptions requiere app access token de ESA app.
 */
function buildLaviletAppAccessToken(appSecret) {
  return `${APP}|${appSecret}`
}

async function inspectWaToken(env) {
  const presence = {}
  for (const name of WA_TOKEN_CANDIDATES) {
    presence[name] = present(env[name])
  }
  presence[EXCLUDED_WEB_TOKEN] = present(env[EXCLUDED_WEB_TOKEN])
  presence.note_excluded =
    'META_CAPI_ACCESS_TOKEN no se usa en este diagnóstico (CAPI web / otra app).'

  let chosen = null
  for (const name of WA_TOKEN_CANDIDATES) {
    if (present(env[name])) {
      chosen = { name, token: String(env[name]).trim() }
      break
    }
  }

  if (!chosen) {
    return {
      presence,
      selected_env: null,
      debug: null,
      usable_for_waba_reads: false,
      reason: 'no_wa_token_present',
    }
  }

  // debug_token: el propio token puede introspectarse como Bearer+input
  const dbg = await debugToken(chosen.token, chosen.token)
  const d = dbg.json?.data || {}
  const appId = d.app_id != null ? String(d.app_id) : null
  const matches = appId === APP
  const scopes = Array.isArray(d.scopes) ? d.scopes : []

  return {
    presence,
    selected_env: chosen.name,
    debug: {
      http: dbg.http,
      error: sanitizeError(dbg.json),
      app_id: appId,
      app_matches_lavilet: matches,
      type: d.type || null,
      is_valid: d.is_valid ?? null,
      scopes,
      has_whatsapp_business_management: scopes.includes(
        'whatsapp_business_management',
      ),
      has_whatsapp_business_messaging: scopes.includes(
        'whatsapp_business_messaging',
      ),
      has_whatsapp_business_manage_events: scopes.includes(
        'whatsapp_business_manage_events',
      ),
    },
    usable_for_waba_reads:
      dbg.http === 200 && d.is_valid !== false && matches,
    reason: matches
      ? null
      : appId
        ? `wa_token_app_mismatch_expected_${APP}_got_${appId}`
        : 'wa_token_debug_failed',
  }
}

async function main() {
  const env = loadEnv()
  const appSecret = String(env.META_WA_APP_SECRET || '').trim()

  const report = {
    checked_at: new Date().toISOString(),
    app_dir: APP_DIR,
    target_app_id: APP,
    auth_model: {
      subscriptions_endpoint: 'app_access_token = APP_ID|META_WA_APP_SECRET',
      waba_reads: 'META_WA_* token only if debug_token.app_id === La Vilet',
      never_uses: EXCLUDED_WEB_TOKEN,
    },
  }

  // --- A) Token WhatsApp existente: app + permisos (sin imprimir valor) ---
  const waInspect = await inspectWaToken(env)
  report.wa_token = {
    selected_env: waInspect.selected_env,
    presence: waInspect.presence,
    debug: waInspect.debug,
    usable_for_waba_reads: waInspect.usable_for_waba_reads,
    reason: waInspect.reason,
  }

  // --- B) /subscriptions con app access token de La Vilet ---
  if (!present(appSecret)) {
    report.ok = false
    report.app_subscriptions = {
      skipped: true,
      reason: 'META_WA_APP_SECRET_missing',
    }
    report.gaps = ['META_WA_APP_SECRET_missing']
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }

  const appAccessToken = buildLaviletAppAccessToken(appSecret)
  const subs = await graphGet(appAccessToken, `/${APP}/subscriptions`)
  // No retener el token en el report
  const list = summarizeSubscriptions(subs.json?.data)

  report.app_subscriptions = {
    http: subs.http,
    error: sanitizeError(subs.json),
    auth_used: 'lavilet_app_access_token',
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

  // --- C) Lecturas WABA solo con token WA de La Vilet ---
  if (waInspect.usable_for_waba_reads) {
    const waToken = String(env[waInspect.selected_env]).trim()

    const subApps = await graphGet(waToken, `/${WABA}/subscribed_apps`)
    const apps = (Array.isArray(subApps.json?.data) ? subApps.json.data : []).map(
      (row) => {
        const wa = row.whatsapp_business_api_data || row
        const override =
          wa.override_callback_uri || row.override_callback_uri || null
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
      token_env: waInspect.selected_env,
      apps,
      has_lavilet: ids.has(APP),
      has_kommo: ids.has(APP_KOMMO),
      only_these_two: ids.size === 2 && ids.has(APP) && ids.has(APP_KOMMO),
    }

    const phone = await graphGet(waToken, `/${PHONE}`, {
      fields: 'id,display_phone_number,webhook_configuration',
    })
    const cfg = phone.json?.webhook_configuration || null
    const appCb = cfg?.application ? hostPath(cfg.application) : null
    const phoneOv = cfg?.phone_number ? hostPath(cfg.phone_number) : null
    report.phone_webhook_configuration = {
      http: phone.http,
      error: sanitizeError(phone.json),
      token_env: waInspect.selected_env,
      keys: cfg ? Object.keys(cfg) : [],
      application_callback_host: appCb?.host || null,
      application_callback_path: appCb?.path || null,
      application_matches_nest:
        Boolean(appCb) &&
        appCb.host === EXPECTED_HOST &&
        appCb.path === EXPECTED_PATH,
      phone_number_override_present: Boolean(phoneOv),
    }

    const waba = await graphGet(waToken, `/${WABA}`, {
      fields:
        'id,name,account_review_status,business_verification_status,ownership_type',
    })
    report.waba = {
      http: waba.http,
      error: sanitizeError(waba.json),
      token_env: waInspect.selected_env,
      id: waba.json?.id || null,
      account_review_status: waba.json?.account_review_status || null,
      business_verification_status:
        waba.json?.business_verification_status || null,
      ownership_type: waba.json?.ownership_type || null,
    }
  } else {
    report.waba_subscribed_apps = {
      skipped: true,
      reason: waInspect.reason || 'wa_token_not_usable',
    }
    report.phone_webhook_configuration = {
      skipped: true,
      reason: waInspect.reason || 'wa_token_not_usable',
    }
  }

  const gaps = []
  if (subs.http !== 200) gaps.push('app_subscriptions_http_failed')
  if (!report.verdict_subscription.matches_all) {
    if (!report.verdict_subscription.has_whatsapp_business_account_object) {
      gaps.push('missing_object_whatsapp_business_account')
    } else {
      if (report.verdict_subscription.active === false) {
        gaps.push('subscription_inactive')
      }
      if (!report.verdict_subscription.has_messages) {
        gaps.push('messages_field_not_subscribed')
      }
      if (!report.verdict_subscription.callback_matches_nest) {
        gaps.push('callback_mismatch_vs_nest')
      }
    }
  }
  if (!waInspect.usable_for_waba_reads) {
    gaps.push('wa_token_not_from_lavilet_or_missing')
  } else if (report.waba_subscribed_apps && !report.waba_subscribed_apps.skipped) {
    if (!report.waba_subscribed_apps.has_lavilet) {
      gaps.push('lavilet_not_in_waba_subscribed_apps')
    }
    if (!report.waba_subscribed_apps.has_kommo) {
      gaps.push('kommo_missing_keep_intact')
    }
  }
  if (
    report.verdict_subscription.matches_all &&
    report.waba_subscribed_apps?.has_lavilet &&
    report.waba_subscribed_apps?.has_kommo
  ) {
    gaps.push(
      'config_looks_aligned_but_production_fanout_unproven__check_meta_delivery_history',
    )
  }

  report.gaps = gaps
  report.next_readonly_checks = [
    'Si verdict_subscription.matches_all: Dashboard → WhatsApp → Webhook recent deliveries (app La Vilet).',
    'Nginx: POST /api/whatsapp/webhook en ventana del inbound real (0 hits ⇒ Meta no intentó Nest).',
    'No usar META_CAPI_ACCESS_TOKEN para diagnósticos WA de la app 1576506134490618.',
  ]
  report.ok = subs.http === 200

  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 3
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      ok: false,
      fatal: e instanceof Error ? e.message : 'error',
    }),
  )
  process.exitCode = 1
})

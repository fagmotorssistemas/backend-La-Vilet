/**
 * Solo lectura: entrega efectiva WABA ↔ app La Vilet.
 * No imprime tokens, secretos ni payloads de mensajes.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '..', '.env.meta-wa-readonly.local')
const API = 'https://graph.facebook.com/v21.0'
const WABA = '1410020224338488'
const APP = '1576506134490618'
const APP_KOMMO = '1022173854571346'
const PHONE = '1372191202637500'
const EXPECTED_HOST = 'capi.lavilett.com'
const EXPECTED_PATH = '/api/whatsapp/webhook'

function loadEnv(filePath) {
  const out = {}
  if (!fs.existsSync(filePath)) return out
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 0) continue
    let v = line.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

function hostPath(urlStr) {
  try {
    const u = new URL(urlStr)
    return { host: u.host, path: u.pathname, configured: true }
  } catch {
    return { host: null, path: null, configured: Boolean(urlStr) }
  }
}

async function graph(token, method, urlPath, query = {}, body = null) {
  const url = new URL(`${API}${urlPath}`)
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).length) url.searchParams.set(k, String(v))
  }
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  }
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  const json = await res.json().catch(() => ({}))
  return { http: res.status, json }
}

function errBrief(json) {
  if (!json?.error) return null
  return {
    code: json.error.code,
    subcode: json.error.error_subcode ?? null,
    type: json.error.type ?? null,
    message: json.error.message,
  }
}

async function main() {
  const env = loadEnv(ENV_FILE)
  const token = String(env.META_WA_READONLY_TOKEN || '').trim()
  const appSecret = String(env.META_WA_APP_SECRET || '').trim()
  const portfolio = String(env.META_BUSINESS_PORTFOLIO_ID || '').trim()
  if (!token) {
    console.log(JSON.stringify({ ok: false, reason: 'token_missing' }))
    process.exitCode = 2
    return
  }

  const out = {
    checked_at: new Date().toISOString(),
    targets: { waba: WABA, app_lavilet: APP, app_kommo: APP_KOMMO, phone: PHONE },
    local_app_secret_present: Boolean(appSecret),
  }

  // 1) Token debug (scopes / app id / type) — sin imprimir token
  const dbg = await graph(token, 'GET', '/debug_token', {
    input_token: token,
  })
  const d = dbg.json?.data || {}
  out.debug_token = {
    http: dbg.http,
    error: errBrief(dbg.json),
    app_id: d.app_id || null,
    app_matches_lavilet: String(d.app_id || '') === APP,
    type: d.type || null,
    is_valid: d.is_valid ?? null,
    expires_at: d.expires_at ?? null,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
    granular: Array.isArray(d.granular_scopes)
      ? d.granular_scopes.map((g) => ({
          scope: g.scope || null,
          target_ids_count: Array.isArray(g.target_ids) ? g.target_ids.length : 0,
          includes_waba: Array.isArray(g.target_ids)
            ? g.target_ids.map(String).includes(WABA)
            : false,
          includes_phone: Array.isArray(g.target_ids)
            ? g.target_ids.map(String).includes(PHONE)
            : false,
        }))
      : [],
  }

  // 2) subscribed_apps (co-suscripción)
  const sub = await graph(token, 'GET', `/${WABA}/subscribed_apps`)
  const apps = (Array.isArray(sub.json?.data) ? sub.json.data : []).map((row) => {
    const wa = row.whatsapp_business_api_data || row
    const override = wa.override_callback_uri || row.override_callback_uri || null
    return {
      id: String(wa.id || ''),
      name: wa.name || null,
      link: wa.link ? hostPath(wa.link).host : null,
      has_override_callback_uri: Boolean(override),
      override_callback: override ? hostPath(override) : null,
      raw_keys: Object.keys(row),
      nested_keys: Object.keys(wa),
    }
  })
  const ids = new Set(apps.map((a) => a.id))
  out.subscribed_apps = {
    http: sub.http,
    error: errBrief(sub.json),
    apps,
    has_lavilet: ids.has(APP),
    has_kommo: ids.has(APP_KOMMO),
    only_these_two: ids.size === 2 && ids.has(APP) && ids.has(APP_KOMMO),
  }

  // 3) Teléfono: webhook_configuration (+ campos override si existen)
  const phone = await graph(token, 'GET', `/${PHONE}`, {
    fields:
      'id,display_phone_number,verified_name,webhook_configuration,name_status,quality_rating,is_official_business_account',
  })
  const cfg = phone.json?.webhook_configuration || null
  const appCb = cfg?.application || null
  const phoneCb = cfg?.phone_number || null
  const appHp = appCb ? hostPath(appCb) : { host: null, path: null, configured: false }
  const phoneHp = phoneCb
    ? hostPath(phoneCb)
    : { host: null, path: null, configured: false }
  out.phone = {
    http: phone.http,
    error: errBrief(phone.json),
    webhook_configuration_keys: cfg ? Object.keys(cfg) : [],
    application_callback: {
      ...appHp,
      matches_nest:
        appHp.host === EXPECTED_HOST && appHp.path === EXPECTED_PATH,
    },
    phone_number_override: {
      present: Boolean(phoneCb),
      ...phoneHp,
      note: phoneCb
        ? 'Override a nivel phone_number (redirige delivery de esa app/número)'
        : 'Sin override phone_number visible',
    },
  }

  // 4) WABA fields: ownership / account review
  const waba = await graph(token, 'GET', `/${WABA}`, {
    fields:
      'id,name,account_review_status,business_verification_status,ownership_type,currency,timezone_id,message_template_namespace',
  })
  out.waba = {
    http: waba.http,
    error: errBrief(waba.json),
    id: waba.json?.id || null,
    name: waba.json?.name || null,
    account_review_status: waba.json?.account_review_status || null,
    business_verification_status: waba.json?.business_verification_status || null,
    ownership_type: waba.json?.ownership_type || null,
  }

  // 5) Client / shared WABAs from business (acceso al activo)
  if (portfolio) {
    const owned = await graph(token, 'GET', `/${portfolio}/owned_whatsapp_business_accounts`, {
      fields: 'id,name',
      limit: 50,
    })
    const client = await graph(
      token,
      'GET',
      `/${portfolio}/client_whatsapp_business_accounts`,
      { fields: 'id,name', limit: 50 },
    )
    const ownedIds = (owned.json?.data || []).map((r) => String(r.id))
    const clientIds = (client.json?.data || []).map((r) => String(r.id))
    out.portfolio_access = {
      portfolio_id: portfolio,
      owned_http: owned.http,
      owned_error: errBrief(owned.json),
      owned_includes_waba: ownedIds.includes(WABA),
      owned_count: ownedIds.length,
      client_http: client.http,
      client_error: errBrief(client.json),
      client_includes_waba: clientIds.includes(WABA),
      client_count: clientIds.length,
    }
  }

  // 6) App object (publicado / tipo) — limitado por token
  const appInfo = await graph(token, 'GET', `/${APP}`, {
    fields: 'id,name,app_type,category,link,namespace',
  })
  out.app_info = {
    http: appInfo.http,
    error: errBrief(appInfo.json),
    id: appInfo.json?.id || null,
    name: appInfo.json?.name || null,
    app_type: appInfo.json?.app_type || null,
    note: 'Live/Published mode no siempre viene en Graph con system user token; Dashboard → App settings → Basic / App mode.',
  }

  // 7) App webhook subscriptions (object + fields) — requiere App Secret
  let appSubs
  if (appSecret) {
    const proof = crypto
      .createHmac('sha256', appSecret)
      .update(token)
      .digest('hex')
    appSubs = await graph(token, 'GET', `/${APP}/subscriptions`, {
      appsecret_proof: proof,
    })
  } else {
    appSubs = await graph(token, 'GET', `/${APP}/subscriptions`)
  }
  const subs = Array.isArray(appSubs.json?.data)
    ? appSubs.json.data.map((d) => {
        const hp = hostPath(d.callback_url || '')
        const fields = Array.isArray(d.fields)
          ? d.fields.map((f) => (typeof f === 'string' ? f : f.name)).filter(Boolean)
          : []
        return {
          object: d.object || null,
          active: d.active ?? null,
          host: hp.host,
          path: hp.path,
          fields,
          has_messages: fields.includes('messages'),
          matches_nest:
            hp.host === EXPECTED_HOST && hp.path === EXPECTED_PATH,
          object_is_waba: d.object === 'whatsapp_business_account',
        }
      })
    : []
  out.app_subscriptions = {
    http: appSubs.http,
    error: errBrief(appSubs.json),
    needs_app_secret: appSubs.json?.error?.code === 190,
    subscriptions: subs,
    has_waba_object_with_messages: subs.some(
      (s) => s.object_is_waba && s.has_messages && s.active !== false,
    ),
    nest_callback_on_waba_sub: subs.some(
      (s) =>
        s.object_is_waba &&
        s.matches_nest &&
        s.has_messages &&
        s.active !== false,
    ),
  }

  // 8) Interpretación
  const gaps = []
  if (!out.subscribed_apps.has_lavilet) gaps.push('lavilet_not_in_subscribed_apps')
  if (!out.subscribed_apps.has_kommo) gaps.push('kommo_missing_from_subscribed_apps')
  if (!out.phone.application_callback.matches_nest)
    gaps.push('phone_application_callback_not_nest')
  if (out.phone.phone_number_override.present)
    gaps.push('phone_number_callback_override_present')
  if (apps.some((a) => a.has_override_callback_uri))
    gaps.push('subscribed_app_override_callback_uri_present')
  if (out.app_subscriptions.needs_app_secret)
    gaps.push('cannot_verify_app_subscriptions_without_app_secret')
  else if (!out.app_subscriptions.has_waba_object_with_messages)
    gaps.push('app_missing_whatsapp_business_account_messages_subscription')
  else if (!out.app_subscriptions.nest_callback_on_waba_sub)
    gaps.push('app_waba_subscription_callback_not_nest_or_inactive')
  if (out.debug_token.app_id && !out.debug_token.app_matches_lavilet)
    gaps.push('readonly_token_not_from_lavilet_app')
  if (
    out.portfolio_access &&
    !out.portfolio_access.owned_includes_waba &&
    !out.portfolio_access.client_includes_waba
  )
    gaps.push('portfolio_lists_do_not_include_waba')

  out.gaps = gaps
  out.delivery_hypothesis = {
    dashboard_test_hits_nest:
      'El Test del App Dashboard POSTea al callback de la app (phone.application / App Webhooks), independiente del fan-out WABA.',
    real_inbound_needs:
      'Mensajes reales: WABA subscribed_apps + app subscription object=whatsapp_business_account field=messages + callback de esa app.',
    observed_symptom:
      'Kommo recibe inbound; Nest sin POST Nginx → fan-out a La Vilet no entrega o app no tiene field messages activo.',
  }

  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: e instanceof Error ? e.message : 'error' }))
  process.exitCode = 1
})

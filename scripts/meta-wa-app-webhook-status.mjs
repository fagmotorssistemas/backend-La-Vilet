/**
 * Solo lectura Graph: suscripciones WABA, teléfono callback, estado app.
 * No imprime tokens. App subscriptions requiere app secret → reporta el límite.
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
    return { host: u.host, path: u.pathname }
  } catch {
    return { host: null, path: null }
  }
}

async function graphGet(token, urlPath, query = {}) {
  const url = new URL(`${API}${urlPath}`)
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).length) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => ({}))
  return { http: res.status, json }
}

async function graphGetAppSecretProof(token, appSecret, urlPath, query = {}) {
  const proof = crypto
    .createHmac('sha256', appSecret)
    .update(token)
    .digest('hex')
  return graphGet(token, urlPath, { ...query, appsecret_proof: proof })
}

async function main() {
  const env = loadEnv(ENV_FILE)
  const token = String(env.META_WA_READONLY_TOKEN || '').trim()
  const appSecret = String(env.META_WA_APP_SECRET || '').trim()
  if (!token) {
    console.log(JSON.stringify({ ok: false, reason: 'token_missing' }))
    process.exitCode = 2
    return
  }

  const subApps = await graphGet(token, `/${WABA}/subscribed_apps`)
  const apps = (Array.isArray(subApps.json?.data) ? subApps.json.data : []).map(
    (row) => {
      const wa = row.whatsapp_business_api_data || row
      return { id: String(wa.id || ''), name: wa.name || null }
    },
  )
  const ids = new Set(apps.map((a) => a.id))

  const phone = await graphGet(token, `/${PHONE}`, {
    fields: 'id,display_phone_number,webhook_configuration',
  })
  const appCb = phone.json?.webhook_configuration?.application || null
  const appCbHp = appCb ? hostPath(appCb) : { host: null, path: null }

  // Estado publicado / info app (algunos campos requieren app token)
  const appInfo = await graphGet(token, `/${APP}`, {
    fields: 'id,name,app_type,link',
  })

  // Suscripciones de webhook de la app (messages) — suele exigir App Secret
  let appSubs
  if (appSecret) {
    appSubs = await graphGetAppSecretProof(token, appSecret, `/${APP}/subscriptions`)
  } else {
    appSubs = await graphGet(token, `/${APP}/subscriptions`)
  }

  const fields = Array.isArray(appSubs.json?.data)
    ? appSubs.json.data.map((d) => ({
        object: d.object || null,
        active: d.active ?? null,
        ...hostPath(d.callback_url || ''),
        field_names: Array.isArray(d.fields)
          ? d.fields.map((f) => (typeof f === 'string' ? f : f.name)).filter(Boolean)
          : [],
      }))
    : []

  console.log(
    JSON.stringify({
      waba_subscribed_apps: apps,
      has_lavilet: ids.has(APP),
      has_kommo: ids.has(APP_KOMMO),
      phone_webhook_application: {
        configured: Boolean(appCb),
        host: appCbHp.host,
        path: appCbHp.path,
        matches_nest:
          appCbHp.host === 'capi.lavilett.com' &&
          appCbHp.path === '/api/whatsapp/webhook',
      },
      app_info_http: appInfo.http,
      app_info: appInfo.json?.error
        ? { error_code: appInfo.json.error.code, message: appInfo.json.error.message }
        : {
            id: appInfo.json?.id || null,
            name: appInfo.json?.name || null,
            app_type: appInfo.json?.app_type || null,
          },
      app_subscriptions_http: appSubs.http,
      app_subscriptions: fields,
      app_subscriptions_error: appSubs.json?.error
        ? {
            code: appSubs.json.error.code,
            message: appSubs.json.error.message,
            needs_app_secret: appSubs.json.error.code === 190,
          }
        : null,
      local_app_secret_present: Boolean(appSecret),
      note: 'Published/Live status often only in App Dashboard; Graph may not expose it on user token.',
    }),
  )
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: e instanceof Error ? e.message : 'error' }))
  process.exitCode = 1
})

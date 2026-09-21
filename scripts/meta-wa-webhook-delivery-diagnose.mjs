/**
 * Diagnóstico solo lectura: suscripciones Graph de la app La Vilet + WABA.
 * No imprime tokens ni secretos.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '..', '.env.meta-wa-readonly.local')
const API = 'https://graph.facebook.com/v21.0'
const WABA = '1410020224338488'
const APP = '1576506134490618'
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

async function main() {
  const token = String(loadEnv(ENV_FILE).META_WA_READONLY_TOKEN || '').trim()
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

  const appSubs = await graphGet(token, `/${APP}/subscriptions`)
  const fields = Array.isArray(appSubs.json?.data)
    ? appSubs.json.data.map((d) => ({
        object: d.object || null,
        callback_url_host: (() => {
          try {
            return d.callback_url ? new URL(d.callback_url).host : null
          } catch {
            return 'invalid_url'
          }
        })(),
        callback_path: (() => {
          try {
            return d.callback_url ? new URL(d.callback_url).pathname : null
          } catch {
            return null
          }
        })(),
        active: d.active ?? null,
        fields: Array.isArray(d.fields)
          ? d.fields.map((f) => f.name || f).filter(Boolean)
          : [],
      }))
    : []

  const phone = await graphGet(token, `/${PHONE}`, {
    fields: 'id,display_phone_number,webhook_configuration',
  })
  const cfg = phone.json?.webhook_configuration || null

  console.log(
    JSON.stringify({
      subscribed_apps: apps,
      app_subscriptions_http: appSubs.http,
      app_subscriptions: fields,
      app_subscriptions_error: appSubs.json?.error
        ? {
            code: appSubs.json.error.code,
            message: appSubs.json.error.message,
          }
        : null,
      phone_http: phone.http,
      webhook_configuration_keys: cfg ? Object.keys(cfg) : [],
      has_application_callback: Boolean(cfg?.application),
      application_callback_host: (() => {
        try {
          return cfg?.application ? new URL(cfg.application).host : null
        } catch {
          return 'invalid'
        }
      })(),
      application_callback_path: (() => {
        try {
          return cfg?.application ? new URL(cfg.application).pathname : null
        } catch {
          return null
        }
      })(),
    }),
  )
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: e instanceof Error ? e.message : 'error' }))
  process.exitCode = 1
})

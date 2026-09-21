/**
 * Solo lectura: lista apps suscritas al WABA (nombres/ids, sin secretos).
 * No POST/DELETE. No imprime tokens.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '..', '.env.meta-wa-readonly.local')
const API = 'https://graph.facebook.com/v21.0'
const WABA = '1410020224338488'

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
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { http: res.status, json }
}

function summarizeError(json) {
  const e = json?.error
  if (!e) return { keys: Object.keys(json || {}) }
  return {
    type: e.type || null,
    code: e.code ?? null,
    subcode: e.error_subcode ?? null,
    message: e.message || null,
    fbtrace_id: e.fbtrace_id || null,
  }
}

async function main() {
  const env = loadEnv(ENV_FILE)
  const token = String(env.META_WA_READONLY_TOKEN || '').trim()
  console.log(
    JSON.stringify({
      env_exists: fs.existsSync(ENV_FILE),
      token_present: Boolean(token),
      token_len: token.length,
      waba: WABA,
    }),
  )
  if (!token) {
    process.exitCode = 2
    return
  }

  const dbg = await graphGet(token, '/debug_token', {
    input_token: token,
    access_token: token,
  })
  if (dbg.http !== 200 || !dbg.json?.data) {
    console.log(
      JSON.stringify({
        step: 'debug_token',
        http: dbg.http,
        error: summarizeError(dbg.json),
      }),
    )
    process.exitCode = 1
    return
  }
  const d = dbg.json.data
  const scopes = Array.isArray(d.scopes) ? [...d.scopes].sort() : []
  console.log(
    JSON.stringify({
      step: 'debug_token',
      valid: d.is_valid,
      type: d.type,
      app_id: d.app_id || null,
      scopes,
      has_whatsapp_business_management: scopes.includes(
        'whatsapp_business_management',
      ),
      has_whatsapp_business_manage_events: scopes.includes(
        'whatsapp_business_manage_events',
      ),
    }),
  )

  const sub = await graphGet(token, `/${WABA}/subscribed_apps`)
  if (sub.http !== 200) {
    console.log(
      JSON.stringify({
        step: 'subscribed_apps',
        http: sub.http,
        error: summarizeError(sub.json),
      }),
    )
  } else {
    const rows = Array.isArray(sub.json?.data) ? sub.json.data : []
    const apps = rows.map((row) => {
      const wa = row.whatsapp_business_api_data || row
      return {
        id: wa.id || null,
        name: wa.name || null,
        has_link: Boolean(wa.link),
        override_callback_uri_present: Boolean(
          row.override_callback_uri || wa.override_callback_uri,
        ),
      }
    })
    console.log(
      JSON.stringify({
        step: 'subscribed_apps',
        http: 200,
        count: apps.length,
        apps,
      }),
    )
  }

  const phones = await graphGet(token, `/${WABA}/phone_numbers`, {
    fields: 'id,display_phone_number,verified_name,webhook_configuration',
  })
  if (phones.http !== 200) {
    console.log(
      JSON.stringify({
        step: 'phone_numbers',
        http: phones.http,
        error: summarizeError(phones.json),
      }),
    )
  } else {
    const list = Array.isArray(phones.json?.data) ? phones.json.data : []
    console.log(
      JSON.stringify({
        step: 'phone_numbers',
        http: 200,
        count: list.length,
        phones: list.map((p) => {
          const digits = String(p.display_phone_number || '').replace(/\D/g, '')
          const cfg = p.webhook_configuration || null
          return {
            phone_id: p.id || null,
            display_last4: digits ? digits.slice(-4) : null,
            verified_name: p.verified_name || null,
            webhook_configuration_keys: cfg ? Object.keys(cfg) : [],
            has_application_callback: Boolean(cfg?.application),
            has_waba_override: Boolean(cfg?.whatsapp_business_account),
            has_phone_override: Boolean(cfg?.phone_number),
          }
        }),
      }),
    )
  }
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      fatal: e instanceof Error ? e.message : 'error',
    }),
  )
  process.exitCode = 1
})

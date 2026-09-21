/**
 * Comprueba (solo lectura) que un token pertenece a la app La Vilet
 * y puede leer subscribed_apps del WABA. No imprime el token.
 *
 * Uso:
 *   META_WA_SUBSCRIBE_TOKEN=... node scripts/meta-wa-cosubscribe-preflight.mjs
 * o token en .env.meta-wa-readonly.local (META_WA_READONLY_TOKEN).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '..', '.env.meta-wa-readonly.local')
const API = 'https://graph.facebook.com/v21.0'
const WABA = '1410020224338488'
const APP_LAVILET = '1576506134490618'
const APP_KOMMO = '1022173854571346'

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
  const fileEnv = loadEnv(ENV_FILE)
  const token = String(
    process.env.META_WA_SUBSCRIBE_TOKEN ||
      fileEnv.META_WA_READONLY_TOKEN ||
      '',
  ).trim()
  console.log(
    JSON.stringify({
      token_present: Boolean(token),
      token_len: token.length,
      expected_app_lavilet: APP_LAVILET,
      expected_app_kommo: APP_KOMMO,
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
  const data = dbg.json?.data || {}
  const scopes = Array.isArray(data.scopes) ? [...data.scopes].sort() : []
  const appId = data.app_id ? String(data.app_id) : null
  console.log(
    JSON.stringify({
      step: 'debug_token',
      http: dbg.http,
      valid: Boolean(data.is_valid),
      type: data.type || null,
      app_id: appId,
      app_matches_lavilet: appId === APP_LAVILET,
      scopes,
      has_whatsapp_business_management: scopes.includes(
        'whatsapp_business_management',
      ),
    }),
  )

  const sub = await graphGet(token, `/${WABA}/subscribed_apps`)
  const rows = Array.isArray(sub.json?.data) ? sub.json.data : []
  const apps = rows.map((row) => {
    const wa = row.whatsapp_business_api_data || row
    return { id: wa.id ? String(wa.id) : null, name: wa.name || null }
  })
  const ids = new Set(apps.map((a) => a.id).filter(Boolean))
  console.log(
    JSON.stringify({
      step: 'subscribed_apps',
      http: sub.http,
      apps,
      has_kommo: ids.has(APP_KOMMO),
      has_lavilet: ids.has(APP_LAVILET),
      ready_for_cosubscribe_post:
        appId === APP_LAVILET &&
        Boolean(data.is_valid) &&
        scopes.includes('whatsapp_business_management') &&
        ids.has(APP_KOMMO) &&
        !ids.has(APP_LAVILET),
    }),
  )
}

main().catch((e) => {
  console.log(JSON.stringify({ fatal: e instanceof Error ? e.message : 'error' }))
  process.exitCode = 1
})

/**
 * POST /{WABA}/subscribed_apps con token La Vilet (solo lectura de .env local).
 * No imprime token. Verifica Kommo + La Vilet por ID exacto.
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

async function graph(method, urlPath, token) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => ({}))
  return { http: res.status, json }
}

function summarizeApps(json) {
  const rows = Array.isArray(json?.data) ? json.data : []
  return rows.map((row) => {
    const wa = row.whatsapp_business_api_data || row
    return { id: wa.id ? String(wa.id) : null, name: wa.name || null }
  })
}

async function main() {
  const env = loadEnv(ENV_FILE)
  const token = String(
    process.env.META_WA_SUBSCRIBE_TOKEN || env.META_WA_READONLY_TOKEN || '',
  ).trim()
  if (!token) {
    console.log(JSON.stringify({ ok: false, reason: 'token_missing' }))
    process.exitCode = 2
    return
  }

  const before = await graph('GET', `/${WABA}/subscribed_apps`, token)
  const beforeApps = summarizeApps(before.json)
  const beforeIds = new Set(beforeApps.map((a) => a.id).filter(Boolean))
  console.log(
    JSON.stringify({
      step: 'before',
      http: before.http,
      apps: beforeApps,
      has_kommo: beforeIds.has(APP_KOMMO),
      has_lavilet: beforeIds.has(APP_LAVILET),
    }),
  )

  if (beforeIds.has(APP_LAVILET) && beforeIds.has(APP_KOMMO)) {
    console.log(JSON.stringify({ step: 'skip_post', reason: 'already_both' }))
    return
  }

  if (!beforeIds.has(APP_KOMMO)) {
    console.log(
      JSON.stringify({
        ok: false,
        step: 'abort',
        reason: 'kommo_missing_before_post',
      }),
    )
    process.exitCode = 3
    return
  }

  const post = await graph('POST', `/${WABA}/subscribed_apps`, token)
  console.log(
    JSON.stringify({
      step: 'post',
      http: post.http,
      success: post.json?.success === true,
      error: post.json?.error
        ? {
            type: post.json.error.type,
            code: post.json.error.code,
            message: post.json.error.message,
            fbtrace_id: post.json.error.fbtrace_id,
          }
        : null,
    }),
  )

  const after = await graph('GET', `/${WABA}/subscribed_apps`, token)
  const afterApps = summarizeApps(after.json)
  const afterIds = new Set(afterApps.map((a) => a.id).filter(Boolean))
  const ok =
    afterIds.has(APP_KOMMO) &&
    afterIds.has(APP_LAVILET) &&
    post.json?.success === true
  console.log(
    JSON.stringify({
      step: 'after',
      http: after.http,
      apps: afterApps,
      has_kommo: afterIds.has(APP_KOMMO),
      has_lavilet: afterIds.has(APP_LAVILET),
      ok,
    }),
  )
  if (!ok) process.exitCode = 4
}

main().catch((e) => {
  console.log(
    JSON.stringify({ fatal: e instanceof Error ? e.message : 'error' }),
  )
  process.exitCode = 1
})

/**
 * Solo lectura: resuelve WABA(s), phone_numbers y GET /{WABA}/dataset.
 * Token desde .env.meta-wa-readonly.local (gitignored).
 * No imprime el token. No hace POST. No toca META_CAPI_ACCESS_TOKEN.
 *
 * Uso:
 *   node scripts/meta-wa-readonly-inspect.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env.meta-wa-readonly.local');
const API = 'https://graph.facebook.com/v21.0';

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function redactPhone(display) {
  const d = String(display || '').replace(/\D/g, '');
  if (d.length < 4) return '(redacted)';
  return `***${d.slice(-4)}`;
}

async function graphGet(token, urlPath, query = {}) {
  const url = new URL(`${API}${urlPath}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).length) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { http: res.status, json };
}

function printError(label, http, json) {
  const err = json && json.error ? json.error : null;
  console.log(`${label}: HTTP ${http}`);
  if (err) {
    console.log(
      `  type=${err.type || '?'} code=${err.code ?? '?'} subcode=${err.error_subcode ?? '-'}`,
    );
    console.log(`  message=${err.message || '?'}`);
    if (err.fbtrace_id) console.log(`  fbtrace_id=${err.fbtrace_id}`);
    console.log(
      '  nota: error de permisos ≠ ausencia de dataset; solo indica falta de acceso con este token.',
    );
  } else {
    console.log(`  body_keys=${Object.keys(json || {}).join(',')}`);
  }
}

async function main() {
  const env = loadEnvFile(ENV_FILE);
  const token = String(env.META_WA_READONLY_TOKEN || '').trim();
  const businessId = String(env.META_BUSINESS_PORTFOLIO_ID || '').trim();
  const phoneHint = String(env.META_WA_DISPLAY_PHONE_HINT || '')
    .trim()
    .replace(/\D/g, '');

  console.log('=== Meta WA readonly inspect ===');
  console.log(
    `env_file=${path.basename(ENV_FILE)} exists=${fs.existsSync(ENV_FILE)}`,
  );
  console.log(`token_present=${Boolean(token)} token_len=${token.length}`);
  console.log(`business_portfolio_id_set=${Boolean(businessId)}`);
  console.log(`phone_hint_digits=${phoneHint ? phoneHint.length : 0}`);

  if (!token) {
    console.log('');
    console.log(
      'FALTA: pega META_WA_READONLY_TOKEN en .env.meta-wa-readonly.local',
    );
    console.log(
      '(no lo pegues en el chat). Conserva META_CAPI_ACCESS_TOKEN del CAPI web.',
    );
    process.exitCode = 2;
    return;
  }

  const dbg = await graphGet(token, '/debug_token', {
    input_token: token,
    access_token: token,
  });
  if (dbg.http !== 200 || !dbg.json.data) {
    printError('debug_token', dbg.http, dbg.json);
    process.exitCode = 1;
    return;
  }
  const d = dbg.json.data;
  const scopes = Array.isArray(d.scopes) ? [...d.scopes].sort() : [];
  console.log(`token_valid=${d.is_valid} type=${d.type} app_id=${d.app_id}`);
  console.log(`scopes=${scopes.join(', ') || '(none)'}`);
  const need = [
    'whatsapp_business_management',
    'whatsapp_business_manage_events',
  ];
  for (const s of need) {
    console.log(`has_${s}=${scopes.includes(s)}`);
  }

  const wabaCandidates = new Set();
  if (Array.isArray(d.granular_scopes)) {
    for (const g of d.granular_scopes) {
      const targets = Array.isArray(g.target_ids) ? g.target_ids : [];
      console.log(
        `granular scope=${g.scope} targets_count=${targets.length}`,
      );
      if (
        String(g.scope || '').includes('whatsapp') ||
        String(g.scope || '') === 'whatsapp_business_management' ||
        String(g.scope || '') === 'whatsapp_business_manage_events'
      ) {
        for (const t of targets) wabaCandidates.add(String(t));
      }
    }
  }

  if (businessId) {
    const owned = await graphGet(
      token,
      `/${businessId}/owned_whatsapp_business_accounts`,
      { fields: 'id,name' },
    );
    if (owned.http === 200 && Array.isArray(owned.json.data)) {
      console.log(`owned_wabas_count=${owned.json.data.length}`);
      for (const row of owned.json.data) {
        console.log(`  owned_waba id=${row.id} name=${row.name || ''}`);
        wabaCandidates.add(String(row.id));
      }
    } else {
      printError('owned_whatsapp_business_accounts', owned.http, owned.json);
    }
  } else {
    console.log(
      'META_BUSINESS_PORTFOLIO_ID no set: no se listó owned_whatsapp_business_accounts',
    );
  }

  if (wabaCandidates.size === 0) {
    console.log('');
    console.log(
      'No hay WABA candidatos desde granular_scopes ni Business Portfolio.',
    );
    console.log(
      'Identificador faltante: META_BUSINESS_PORTFOLIO_ID (Business Manager → Business info → Business ID)',
    );
    console.log(
      'o WABA ID actual visible en WhatsApp accounts tras la reconexión.',
    );
    process.exitCode = 3;
    return;
  }

  const summaries = [];
  for (const wabaId of wabaCandidates) {
    console.log('');
    console.log(`--- WABA ${wabaId} ---`);
    const phones = await graphGet(token, `/${wabaId}/phone_numbers`, {
      fields: 'id,display_phone_number,verified_name,quality_rating',
    });
    let phonesCount = 0;
    let hintMatch = false;
    if (phones.http !== 200) {
      printError('phone_numbers', phones.http, phones.json);
    } else {
      const list = Array.isArray(phones.json.data) ? phones.json.data : [];
      phonesCount = list.length;
      console.log(`phone_numbers_count=${list.length}`);
      for (const p of list) {
        const digits = String(p.display_phone_number || '').replace(/\D/g, '');
        const match =
          phoneHint && digits.endsWith(phoneHint) ? ' HINT_MATCH' : '';
        if (match) hintMatch = true;
        console.log(
          `  phone_id=${p.id} display=${redactPhone(p.display_phone_number)} verified_name=${p.verified_name || ''}${match}`,
        );
      }
    }

    const ds = await graphGet(token, `/${wabaId}/dataset`);
    let datasetId = null;
    if (ds.http === 200) {
      if (typeof ds.json.id === 'string') datasetId = ds.json.id;
      else if (Array.isArray(ds.json.data) && ds.json.data[0]?.id) {
        datasetId = String(ds.json.data[0].id);
      } else if (typeof ds.json.data === 'string') datasetId = ds.json.data;
      console.log(
        `dataset_http=200 dataset_id=${datasetId || '(parse_pending)'}`,
      );
      if (!datasetId) {
        console.log(`dataset_raw_keys=${Object.keys(ds.json).join(',')}`);
      }
    } else {
      printError('dataset', ds.http, ds.json);
    }

    summaries.push({
      wabaId,
      phonesCount,
      hintMatch,
      datasetId,
      datasetHttp: ds.http,
    });
  }

  console.log('');
  console.log('=== Resumen ===');
  const withHint = summaries.filter((r) => r.hintMatch);
  if (withHint.length) {
    console.log(
      `WABA con hint de número Kommo: ${withHint.map((r) => r.wabaId).join(', ')}`,
    );
  } else if (phoneHint) {
    console.log(
      'Ningún display_phone_number terminó con META_WA_DISPLAY_PHONE_HINT.',
    );
  } else {
    console.log(
      'Sin META_WA_DISPLAY_PHONE_HINT: no se contrastó el número Kommo automáticamente.',
    );
    console.log(
      'Opcional: añade últimos 4–6 dígitos en META_WA_DISPLAY_PHONE_HINT.',
    );
  }
  const withDs = summaries.filter((r) => r.datasetId);
  if (withDs.length) {
    for (const r of withDs) {
      console.log(`CONFIRMADO waba=${r.wabaId} dataset=${r.datasetId}`);
    }
  } else {
    console.log(
      'Dataset ID no confirmado (ver errores GET /dataset; no interpretar como inexistente).',
    );
  }
}

main().catch((e) => {
  console.log(`fatal=${e instanceof Error ? e.message : 'error'}`);
  process.exitCode = 1;
});

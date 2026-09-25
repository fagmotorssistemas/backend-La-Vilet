/**
 * Diagnóstico local Meta: dataset + catálogos + envío CAPI test.
 * No imprime tokens ni PII. Borrar tras uso si se desea.
 */
import fs from 'fs';
import crypto from 'crypto';

function loadEnv(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function redact(obj, token) {
  const s = JSON.stringify(obj);
  if (!token) return JSON.parse(s);
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return JSON.parse(s.replace(new RegExp(esc, 'g'), '[TOKEN]'));
}

const env = loadEnv('.env');
const token = env.META_CAPI_ACCESS_TOKEN;
const dataset = env.META_DATASET_ID || env.META_PIXEL_ID;
const ver = env.META_API_VERSION || 'v21.0';
const testCode = env.META_TEST_EVENT_CODE;
const catalogIdArg = process.argv[2] || env.META_HOME_LISTING_CATALOG_ID || '';

if (!token || !dataset) {
  console.log(JSON.stringify({ ok: false, reason: 'missing_token_or_dataset' }));
  process.exit(1);
}

async function graph(method, path, body) {
  const url = new URL(`https://graph.facebook.com/${ver}${path}`);
  if (method === 'GET') url.searchParams.set('access_token', token);
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify({ ...(body || {}), access_token: token });
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

const results = {
  dataset,
  api_version: ver,
  has_test_code: Boolean(testCode),
  catalog_id_arg: catalogIdArg || null,
};

results.dataset_get = redact(
  await graph('GET', `/${dataset}?fields=id,name,owner_business`),
  token,
);
results.me = redact(await graph('GET', '/me?fields=id,name'), token);
results.me_businesses = redact(
  await graph('GET', '/me/businesses?fields=id,name&limit=25'),
  token,
);

const businesses = results.me_businesses?.json?.data || [];
results.catalogs = [];
for (const b of businesses.slice(0, 8)) {
  const cats = await graph(
    'GET',
    `/${b.id}/owned_product_catalogs?fields=id,name,vertical,product_count&limit=50`,
  );
  results.catalogs.push({ business_id: b.id, ...redact(cats, token) });
}

const homeListingCatalogs = [];
for (const block of results.catalogs) {
  for (const c of block.json?.data || []) {
    if (String(c.vertical || '').toLowerCase().includes('home')) {
      homeListingCatalogs.push(c);
    }
  }
}
results.home_listing_catalogs = homeListingCatalogs;

const catalogIds = [
  ...new Set(
    [
      catalogIdArg,
      ...homeListingCatalogs.map((c) => c.id),
      ...(results.catalogs.flatMap((b) => (b.json?.data || []).map((c) => c.id)) ||
        []),
    ].filter(Boolean),
  ),
].slice(0, 10);

results.catalog_checks = [];
for (const cid of catalogIds) {
  const meta = await graph(
    'GET',
    `/${cid}?fields=id,name,vertical,product_count`,
  );
  const sources = await graph('GET', `/${cid}/external_event_sources`);
  const listings = await graph(
    'GET',
    `/${cid}/home_listings?fields=id,home_listing_id,name,url&limit=5`,
  );
  const pixelLinked = Boolean(
    (sources.json?.data || []).some(
      (s) => String(s.id) === String(dataset) || String(s.source_id) === String(dataset),
    ),
  );
  results.catalog_checks.push({
    catalog_id: cid,
    meta: redact(meta, token),
    external_event_sources: redact(sources, token),
    sample_home_listings: redact(listings, token),
    pixel_dataset_linked: pixelLinked,
  });
}

// Enviar evento CAPI de prueba con home_listing
const sampleListingId =
  results.catalog_checks
    .flatMap((c) => c.sample_home_listings?.json?.data || [])
    .map((x) => x.home_listing_id || x.id)
    .find(Boolean) || `diag-${crypto.randomUUID()}`;

const eventId = crypto.randomUUID();
const eventTime = Math.floor(Date.now() / 1000);
const capiBody = {
  data: [
    {
      event_name: 'ViewContent',
      event_time: eventTime,
      event_id: eventId,
      action_source: 'website',
      event_source_url: 'https://www.lavilett.com',
      user_data: {
        client_user_agent:
          'lavilet-meta-capi-diag/1.0 (+https://www.lavilett.com)',
        // hashed dummy email so Meta accepts match keys without real PII
        em: [
          crypto.createHash('sha256').update('diag@example.com').digest('hex'),
        ],
      },
      custom_data: {
        content_type: 'home_listing',
        content_ids: [sampleListingId],
      },
    },
  ],
};
if (testCode) capiBody.test_event_code = testCode;

results.capi_test_send = {
  event_id: eventId,
  content_ids: [sampleListingId],
  content_type: 'home_listing',
  used_test_code: Boolean(testCode),
  response: redact(await graph('POST', `/${dataset}/events`, capiBody), token),
};

console.log(JSON.stringify(results, null, 2));

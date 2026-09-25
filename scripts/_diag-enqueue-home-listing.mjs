/**
 * Enqueue ViewContent detalle_unidad via Nest and inspect outbox Graph payload.
 * No secrets printed.
 */
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';

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

const env = loadEnv('.env');
const secret = env.META_CAPI_INTERNAL_SECRET;
const port = env.PORT || '3010';
const unitId = process.argv[2] || crypto.randomUUID();
const eventId = crypto.randomUUID();
const eventTime = Math.floor(Date.now() / 1000);
const idem = `diag:view:${eventId}`;

const body = {
  event_name: 'ViewContent',
  event_id: eventId,
  event_time: eventTime,
  action_source: 'website',
  ads_consent: true,
  delivery_lane: 'test',
  idempotency_key: idem,
  lv_internal_subtype: 'detalle_unidad',
  unit_id: unitId,
  visitor_key: crypto.randomUUID(),
  event_source_url: 'https://www.lavilett.com/tour/unidad/' + unitId,
  client_user_agent: 'lavilet-diag/1.0',
};

const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Secret': secret,
  },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({}));
console.log(
  JSON.stringify(
    {
      http_status: res.status,
      enqueue: json,
      unit_id: unitId,
      event_id: eventId,
    },
    null,
    2,
  ),
);

// Wait briefly for outbox worker
await new Promise((r) => setTimeout(r, 8000));

const dbPath = env.DATABASE_PATH || './data/lavilet-meta-capi.db';
const db = new Database(dbPath, { readonly: true });
const row = db
  .prepare(
    `SELECT event_id, event_name, status, attempt_count, last_error,
            graph_payload, payload_redacted, sent_at, delivery_lane
     FROM outbox_events WHERE event_id = ?`,
  )
  .get(eventId);

if (!row) {
  console.log(JSON.stringify({ outbox: null }));
  process.exit(0);
}

let graph;
try {
  graph = JSON.parse(row.graph_payload);
} catch {
  graph = null;
}
const event = graph?.data?.[0] || null;
const custom = event?.custom_data || null;

console.log(
  JSON.stringify(
    {
      outbox: {
        status: row.status,
        attempt_count: row.attempt_count,
        last_error: row.last_error,
        sent_at: row.sent_at,
        delivery_lane: row.delivery_lane,
        custom_data: custom,
        has_test_event_code: Boolean(graph?.test_event_code),
        action_source: event?.action_source,
        event_source_url: event?.event_source_url,
      },
    },
    null,
    2,
  ),
);
db.close();

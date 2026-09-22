#!/usr/bin/env bash
# Diagnóstico SOLO LECTURA — dos ViewContent históricos + uno conocido.
# Ejecutar en el droplet. Usa better-sqlite3 del contenedor (no requiere sqlite3 CLI).
# No imprime payloads personales ni secretos.

set -euo pipefail

CONTAINER="${CONTAINER:-lavilet-capi-lavilet-meta-capi-1}"

docker exec -i "$CONTAINER" node -e '
const Database = require("better-sqlite3");
const path = "/data/lavilet-meta-capi.db";
const ids = [
  ["pending_a", "73332442-ad30-41cb-a84e-213062c81807"],
  ["pending_b", "123ddc30-a6dc-4861-a87e-9ea22cebd313"],
  ["known_ok", "80d45198-eef3-4a69-93f5-7c43057b89b7"],
];
const db = new Database(path, { readonly: true, fileMustExist: true });
const counts = db.prepare("SELECT status, COUNT(*) AS c FROM outbox_events GROUP BY status").all();
console.log(JSON.stringify({ kind: "counts_by_status", counts }));
const stmt = db.prepare(
  "SELECT event_id, event_name, status, delivery_lane, attempt_count, sent_at, created_at, updated_at, " +
  "CASE WHEN meta_response_redacted IS NULL THEN 0 ELSE 1 END AS has_meta, " +
  "substr(coalesce(last_error,\"\"), 1, 80) AS last_error_prefix " +
  "FROM outbox_events WHERE event_id = ? ORDER BY id DESC LIMIT 1"
);
for (const [label, id] of ids) {
  const row = stmt.get(id);
  console.log(JSON.stringify(row
    ? { kind: "row", label, found: true, ...row }
    : { kind: "row", label, found: false, event_id: id }));
}
const purgeEligible = db.prepare(
  "SELECT COUNT(*) AS c FROM outbox_events WHERE status = \"sent\" AND sent_at IS NOT NULL AND sent_at < datetime(\"now\", \"-90 days\")"
).get();
console.log(JSON.stringify({ kind: "purge_eligible_sent_90d", ...purgeEligible }));
db.close();
'

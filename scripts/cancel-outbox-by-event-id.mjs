#!/usr/bin/env node
/**
 * Cancela por event_id en SQLite Nest sin borrar filas ni llamar a Meta.
 *
 * Uso (en el host/contenedor DO, META_MODE=disabled):
 *   node scripts/cancel-outbox-by-event-id.mjs \
 *     123ddc30-a6dc-4861-a87e-9ea22cebd313 \
 *     73332442-ad30-41cb-a84e-213062c81807
 *
 * DATABASE_PATH por defecto: /data/lavilet-meta-capi.db (Docker) o ./data/...
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const reason = process.env.CANCEL_REASON || 'core_setup_hold';
const dbPath =
  process.env.DATABASE_PATH ||
  (fs.existsSync('/data/lavilet-meta-capi.db')
    ? '/data/lavilet-meta-capi.db'
    : path.join(process.cwd(), 'data', 'lavilet-meta-capi.db'));

const ids = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!ids.length) {
  console.error('Uso: node scripts/cancel-outbox-by-event-id.mjs <event_id>...');
  process.exit(2);
}

const db = new Database(dbPath);
const placeholders = ids.map(() => '?').join(',');
const before = db
  .prepare(
    `SELECT id, event_id, status, last_error FROM outbox_events WHERE event_id IN (${placeholders})`,
  )
  .all(...ids);

const result = db
  .prepare(
    `UPDATE outbox_events
     SET status = 'cancelled',
         last_error = ?,
         updated_at = datetime('now')
     WHERE event_id IN (${placeholders})
       AND status IN ('pending', 'failed', 'processing', 'dead')`,
  )
  .run(reason.slice(0, 500), ...ids);

const after = db
  .prepare(
    `SELECT id, event_id, status, last_error FROM outbox_events WHERE event_id IN (${placeholders})`,
  )
  .all(...ids);

console.log(
  JSON.stringify(
    {
      database_path: dbPath,
      reason,
      updated: result.changes,
      before,
      after,
    },
    null,
    2,
  ),
);
db.close();

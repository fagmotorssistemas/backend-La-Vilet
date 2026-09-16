#!/usr/bin/env node
/**
 * Cancela por event_id en SQLite Nest sin borrar filas ni llamar a Meta.
 *
 * Uso (contenedor DO, META_MODE=disabled):
 *   META_MODE=disabled DATABASE_PATH=/data/lavilet-meta-capi.db \
 *     node scripts/cancel-outbox-by-event-id.mjs <event_id>...
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const mode = String(process.env.META_MODE || '')
  .trim()
  .toLowerCase();
if (mode !== 'disabled') {
  console.error(
    JSON.stringify({
      ok: false,
      error: 'META_MODE_must_be_disabled',
      meta_mode: process.env.META_MODE ?? null,
    }),
  );
  process.exit(1);
}

const reason = process.env.CANCEL_REASON || 'core_setup_hold';
const dbPath =
  process.env.DATABASE_PATH ||
  (fs.existsSync('/data/lavilet-meta-capi.db')
    ? '/data/lavilet-meta-capi.db'
    : path.join(process.cwd(), 'data', 'lavilet-meta-capi.db'));

const ids = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
if (!ids.length) {
  console.error(
    'Uso: META_MODE=disabled node scripts/cancel-outbox-by-event-id.mjs <event_id>...',
  );
  process.exit(2);
}

if (!fs.existsSync(dbPath)) {
  console.error(
    JSON.stringify({ ok: false, error: 'database_missing', database_path: dbPath }),
  );
  process.exit(1);
}

const db = new Database(dbPath, { fileMustExist: true, readonly: false });
const placeholders = ids.map(() => '?').join(',');

const countBeforeAll = db
  .prepare(`SELECT COUNT(*) AS c FROM outbox_events`)
  .get().c;

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

const countAfterAll = db
  .prepare(`SELECT COUNT(*) AS c FROM outbox_events`)
  .get().c;

const untouchedOtherPending = db
  .prepare(
    `SELECT COUNT(*) AS c FROM outbox_events
     WHERE status = 'pending'
       AND event_id NOT IN (${placeholders})`,
  )
  .get(...ids).c;

console.log(
  JSON.stringify(
    {
      ok: true,
      database_path: dbPath,
      reason,
      updated: result.changes,
      rows_total_before: countBeforeAll,
      rows_total_after: countAfterAll,
      rows_preserved: countBeforeAll === countAfterAll,
      other_pending_untouched: untouchedOtherPending,
      before,
      after,
    },
    null,
    2,
  ),
);
db.close();

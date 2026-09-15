import Database from 'better-sqlite3';

export type DeliveryLane = 'test' | 'live';

export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'dead'
  | 'cancelled';

export type OutboxRow = {
  id: number;
  idempotency_key: string;
  event_id: string;
  event_name: string;
  event_time: number;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  payload_redacted: string;
  graph_payload: string;
  dataset_id: string;
  delivery_lane: DeliveryLane;
  visitor_key: string | null;
  lead_id: string | null;
  ads_consent_required: number;
  meta_response_redacted: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

/** Capa SQLite sin Nest — testeable y usada por DatabaseService. */
export class SqliteOutboxStore {
  constructor(private readonly db: Database.Database) {}

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        payload_redacted TEXT NOT NULL,
        graph_payload TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        meta_response_redacted TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status_next
        ON outbox_events(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_event_id
        ON outbox_events(event_id);

      CREATE TABLE IF NOT EXISTS worker_locks (
        lock_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consent_state (
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        ads_allowed INTEGER NOT NULL,
        consent_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_type, scope_key)
      );
    `);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('001_outbox')`,
      )
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('002_recover_processing')`,
      )
      .run();

    const cols = this.db
      .prepare(`PRAGMA table_info(outbox_events)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('delivery_lane')) {
      this.db.exec(
        `ALTER TABLE outbox_events ADD COLUMN delivery_lane TEXT NOT NULL DEFAULT 'live'`,
      );
    }
    if (!names.has('visitor_key')) {
      this.db.exec(`ALTER TABLE outbox_events ADD COLUMN visitor_key TEXT`);
    }
    if (!names.has('lead_id')) {
      this.db.exec(`ALTER TABLE outbox_events ADD COLUMN lead_id TEXT`);
    }
    if (!names.has('ads_consent_required')) {
      this.db.exec(
        `ALTER TABLE outbox_events ADD COLUMN ads_consent_required INTEGER NOT NULL DEFAULT 1`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('003_delivery_lane')`,
      )
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('004_consent_scopes')`,
      )
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('005_worker_locks')`,
      )
      .run();

    // Migrar consent_revocations legacy → consent_state versionado
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));
    if (tableNames.has('consent_revocations') && tableNames.has('consent_state')) {
      this.db.exec(`
        INSERT OR IGNORE INTO consent_state (scope_type, scope_key, ads_allowed, consent_version, updated_at)
        SELECT scope_type, scope_key, 0,
               CAST(strftime('%s', revoked_at) AS INTEGER) * 1000,
               revoked_at
        FROM consent_revocations;
      `);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('006_consent_state_versioned')`,
      )
      .run();
  }

  recoverStuckProcessing(): number {
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'pending',
             next_attempt_at = datetime('now'),
             last_error = COALESCE(last_error, 'recovered_after_restart'),
             updated_at = datetime('now')
         WHERE status = 'processing'`,
      )
      .run();
    return result.changes;
  }

  /** Libera locks caducados (reinicio / crash del worker). */
  releaseExpiredLocks(nowIso = new Date().toISOString()): number {
    return this.db
      .prepare(`DELETE FROM worker_locks WHERE expires_at <= ?`)
      .run(nowIso).changes;
  }

  tryAcquireLock(
    lockName: string,
    ownerId: string,
    ttlMs: number,
  ): boolean {
    this.releaseExpiredLocks();
    const now = Date.now();
    const expires = new Date(now + Math.max(5_000, ttlMs)).toISOString();
    const nowIso = new Date(now).toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO worker_locks (lock_name, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(lockName, ownerId, nowIso, expires);
      return true;
    } catch {
      const row = this.db
        .prepare(`SELECT owner_id, expires_at FROM worker_locks WHERE lock_name = ?`)
        .get(lockName) as { owner_id: string; expires_at: string } | undefined;
      if (!row) return false;
      if (row.expires_at <= nowIso) {
        this.db.prepare(`DELETE FROM worker_locks WHERE lock_name = ?`).run(lockName);
        try {
          this.db
            .prepare(
              `INSERT INTO worker_locks (lock_name, owner_id, acquired_at, expires_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(lockName, ownerId, nowIso, expires);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  releaseLock(lockName: string, ownerId: string): void {
    this.db
      .prepare(`DELETE FROM worker_locks WHERE lock_name = ? AND owner_id = ?`)
      .run(lockName, ownerId);
  }

  /** Solo pruebas: fuerza caducidad de un lock. */
  forceExpireLock(lockName: string, expiresAtIso: string): void {
    this.db
      .prepare(`UPDATE worker_locks SET expires_at = ? WHERE lock_name = ?`)
      .run(expiresAtIso, lockName);
  }

  revokeConsent(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
    consentVersion: number,
  ): number {
    if (!Number.isFinite(consentVersion) || consentVersion < 1) {
      throw new Error('consent_version_required');
    }
    const key = scopeKey.trim();
    if (!key) return 0;
    const now = new Date().toISOString();
    const applied = this.applyConsentState(scopeType, key, false, consentVersion, now);
    if (!applied) return 0;

    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'cancelled',
             last_error = 'ads_consent_revoked',
             updated_at = datetime('now')
         WHERE status IN ('pending', 'failed', 'processing')
           AND ads_consent_required = 1
           AND (
             (? = 'visitor' AND visitor_key = ?)
             OR (? = 'lead' AND lead_id = ?)
           )`,
      )
      .run(scopeType, key, scopeType, key);
    return result.changes;
  }

  grantConsent(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
    consentVersion: number,
  ): boolean {
    if (!Number.isFinite(consentVersion) || consentVersion < 1) {
      throw new Error('consent_version_required');
    }
    const key = scopeKey.trim();
    if (!key) return false;
    const now = new Date().toISOString();
    return this.applyConsentState(scopeType, key, true, consentVersion, now);
  }

  /** Cancela pendientes sin tocar consent_state (sin inventar versión). */
  cancelPendingForScope(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
  ): number {
    const key = scopeKey.trim();
    if (!key) return 0;
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'cancelled',
             last_error = 'ads_consent_revoked',
             updated_at = datetime('now')
         WHERE status IN ('pending', 'failed', 'processing')
           AND ads_consent_required = 1
           AND (
             (? = 'visitor' AND visitor_key = ?)
             OR (? = 'lead' AND lead_id = ?)
           )`,
      )
      .run(scopeType, key, scopeType, key);
    return result.changes;
  }

  getConsentVersion(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
  ): number | null {
    const row = this.db
      .prepare(
        `SELECT consent_version FROM consent_state
         WHERE scope_type = ? AND scope_key = ?`,
      )
      .get(scopeType, scopeKey) as { consent_version: number } | undefined;
    return row ? Number(row.consent_version) : null;
  }

  /** Solo aplica si consent_version >= la ya registrada (anti-grant atrasado). */
  private applyConsentState(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
    adsAllowed: boolean,
    consentVersion: number,
    updatedAt: string,
  ): boolean {
    const existing = this.db
      .prepare(
        `SELECT consent_version FROM consent_state
         WHERE scope_type = ? AND scope_key = ?`,
      )
      .get(scopeType, scopeKey) as { consent_version: number } | undefined;

    if (existing && Number(existing.consent_version) > Number(consentVersion)) {
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO consent_state (scope_type, scope_key, ads_allowed, consent_version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_type, scope_key) DO UPDATE SET
           ads_allowed = excluded.ads_allowed,
           consent_version = excluded.consent_version,
           updated_at = excluded.updated_at
         WHERE excluded.consent_version >= consent_state.consent_version`,
      )
      .run(scopeType, scopeKey, adsAllowed ? 1 : 0, consentVersion, updatedAt);
    return true;
  }

  isConsentRevoked(opts: {
    visitorKey?: string | null;
    leadId?: string | null;
  }): boolean {
    if (opts.leadId) {
      const row = this.db
        .prepare(
          `SELECT ads_allowed FROM consent_state
           WHERE scope_type = 'lead' AND scope_key = ?`,
        )
        .get(opts.leadId) as { ads_allowed: number } | undefined;
      if (row && row.ads_allowed === 0) return true;
    }
    if (opts.visitorKey) {
      const row = this.db
        .prepare(
          `SELECT ads_allowed FROM consent_state
           WHERE scope_type = 'visitor' AND scope_key = ?`,
        )
        .get(opts.visitorKey) as { ads_allowed: number } | undefined;
      if (row && row.ads_allowed === 0) return true;
    }
    return false;
  }

  insertOutbox(input: {
    idempotency_key: string;
    event_id: string;
    event_name: string;
    event_time: number;
    payload_redacted: unknown;
    graph_payload: unknown;
    dataset_id: string;
    delivery_lane: DeliveryLane;
    visitor_key?: string | null;
    lead_id?: string | null;
    ads_consent_required?: boolean;
  }): { inserted: boolean; row: OutboxRow; blocked_by_consent?: boolean } {
    if (
      this.isConsentRevoked({
        visitorKey: input.visitor_key,
        leadId: input.lead_id,
      })
    ) {
      // Evento atrasado no reactiva consentimiento: se registra cancelled.
      const existing = this.db
        .prepare('SELECT * FROM outbox_events WHERE idempotency_key = ?')
        .get(input.idempotency_key) as OutboxRow | undefined;
      if (existing) return { inserted: false, row: existing, blocked_by_consent: true };

      this.db
        .prepare(
          `INSERT INTO outbox_events (
            idempotency_key, event_id, event_name, event_time, status,
            next_attempt_at, payload_redacted, graph_payload, dataset_id,
            delivery_lane, visitor_key, lead_id, ads_consent_required, last_error
          ) VALUES (
            @idempotency_key, @event_id, @event_name, @event_time, 'cancelled',
            NULL, @payload_redacted, @graph_payload, @dataset_id,
            @delivery_lane, @visitor_key, @lead_id, @ads_consent_required,
            'ads_consent_revoked_late_event'
          )`,
        )
        .run({
          idempotency_key: input.idempotency_key,
          event_id: input.event_id,
          event_name: input.event_name,
          event_time: input.event_time,
          payload_redacted: JSON.stringify(input.payload_redacted),
          graph_payload: JSON.stringify(input.graph_payload),
          dataset_id: input.dataset_id,
          delivery_lane: input.delivery_lane,
          visitor_key: input.visitor_key || null,
          lead_id: input.lead_id || null,
          ads_consent_required: input.ads_consent_required === false ? 0 : 1,
        });
      const row = this.db
        .prepare('SELECT * FROM outbox_events WHERE idempotency_key = ?')
        .get(input.idempotency_key) as OutboxRow;
      return { inserted: false, row, blocked_by_consent: true };
    }

    const existing = this.db
      .prepare('SELECT * FROM outbox_events WHERE idempotency_key = ?')
      .get(input.idempotency_key) as OutboxRow | undefined;
    if (existing) return { inserted: false, row: existing };

    try {
      this.db
        .prepare(
          `INSERT INTO outbox_events (
            idempotency_key, event_id, event_name, event_time, status,
            next_attempt_at, payload_redacted, graph_payload, dataset_id,
            delivery_lane, visitor_key, lead_id, ads_consent_required
          ) VALUES (
            @idempotency_key, @event_id, @event_name, @event_time, 'pending',
            datetime('now'), @payload_redacted, @graph_payload, @dataset_id,
            @delivery_lane, @visitor_key, @lead_id, @ads_consent_required
          )`,
        )
        .run({
          idempotency_key: input.idempotency_key,
          event_id: input.event_id,
          event_name: input.event_name,
          event_time: input.event_time,
          payload_redacted: JSON.stringify(input.payload_redacted),
          graph_payload: JSON.stringify(input.graph_payload),
          dataset_id: input.dataset_id,
          delivery_lane: input.delivery_lane,
          visitor_key: input.visitor_key || null,
          lead_id: input.lead_id || null,
          ads_consent_required: input.ads_consent_required === false ? 0 : 1,
        });
    } catch {
      const again = this.db
        .prepare('SELECT * FROM outbox_events WHERE idempotency_key = ?')
        .get(input.idempotency_key) as OutboxRow | undefined;
      if (again) return { inserted: false, row: again };
      throw new Error('insert_outbox_failed');
    }

    const row = this.db
      .prepare('SELECT * FROM outbox_events WHERE idempotency_key = ?')
      .get(input.idempotency_key) as OutboxRow;
    return { inserted: true, row };
  }

  claimPending(limit: number, deliveryLane: DeliveryLane): OutboxRow[] {
    const nowIso = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_events
           WHERE status IN ('pending', 'failed')
             AND delivery_lane = @lane
             AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
           ORDER BY id ASC
           LIMIT @limit`,
        )
        .all({ now: nowIso, limit, lane: deliveryLane }) as OutboxRow[];

      const claimed: OutboxRow[] = [];
      for (const row of rows) {
        if (
          row.ads_consent_required &&
          this.isConsentRevoked({
            visitorKey: row.visitor_key,
            leadId: row.lead_id,
          })
        ) {
          this.db
            .prepare(
              `UPDATE outbox_events
               SET status = 'cancelled',
                   last_error = 'ads_consent_revoked',
                   updated_at = datetime('now')
               WHERE id = ?`,
            )
            .run(row.id);
          continue;
        }

        const result = this.db
          .prepare(
            `UPDATE outbox_events
             SET status = 'processing',
                 attempt_count = attempt_count + 1,
                 updated_at = datetime('now')
             WHERE id = @id AND status IN ('pending', 'failed')`,
          )
          .run({ id: row.id });
        if (result.changes === 1) {
          claimed.push({
            ...row,
            status: 'processing',
            attempt_count: row.attempt_count + 1,
          });
        }
      }
      return claimed;
    });
    return tx();
  }

  getOutboxById(id: number): OutboxRow | undefined {
    return this.db
      .prepare(`SELECT * FROM outbox_events WHERE id = ?`)
      .get(id) as OutboxRow | undefined;
  }

  markSent(id: number, metaResponseRedacted: unknown): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'sent',
             sent_at = datetime('now'),
             updated_at = datetime('now'),
             last_error = NULL,
             meta_response_redacted = @meta
         WHERE id = @id AND status = 'processing'`,
      )
      .run({ id, meta: JSON.stringify(metaResponseRedacted) });
    return result.changes === 1;
  }

  markRetry(
    id: number,
    error: string,
    nextAttemptAt: string,
    dead: boolean,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = @status,
             last_error = @error,
             next_attempt_at = @next,
             updated_at = datetime('now')
         WHERE id = @id AND status = 'processing'`,
      )
      .run({
        id,
        status: dead ? 'dead' : 'failed',
        error: error.slice(0, 500),
        next: nextAttemptAt,
      });
    return result.changes === 1;
  }

  cancelProcessingIfRevoked(id: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'cancelled',
             last_error = 'ads_consent_revoked',
             updated_at = datetime('now')
         WHERE id = ? AND status = 'processing'`,
      )
      .run(id);
    return result.changes === 1;
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM outbox_events GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.c;
    return out;
  }

  purgeOld(retentionDays: number) {
    this.db
      .prepare(
        `DELETE FROM outbox_events
         WHERE status = 'sent'
           AND sent_at IS NOT NULL
           AND sent_at < datetime('now', @offset)`,
      )
      .run({ offset: `-${Math.max(1, retentionDays)} days` });
  }
}

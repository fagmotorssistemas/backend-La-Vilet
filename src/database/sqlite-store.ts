import Database from 'better-sqlite3';

export type DeliveryLane = 'test' | 'live';

export type OutboxStatus =
  'pending' | 'processing' | 'sent' | 'failed' | 'dead' | 'cancelled';

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
  delivery_outcome: string;
  /** Veces que el worker retuvo la fila sin enviarla (gate). Define la espera. */
  hold_count: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type MetaResultSyncRow = {
  id: number;
  outbox_event_id: number;
  event_id: string;
  stage: string;
  payload_json: string;
  /** dead: rechazo permanente de Supabase o intentos agotados (no se reintenta). */
  status: 'pending' | 'sent' | 'dead';
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

/** Recibo Cloud API WA: atribución CTWA + correlación CRM (sin cuerpo de mensaje). */
export type WaCloudReceiptRow = {
  wamid: string;
  wa_id_normalized: string | null;
  wa_id_raw: string;
  phone_number_id: string;
  waba_id: string;
  has_ctwa: number;
  ctwa_clid: string | null;
  referral_source_type: string | null;
  source_id: string | null;
  source_url: string | null;
  field_path: string | null;
  /** Diagnóstico extracción: no_referral_object | clid_absent | clid_rejected | extracted */
  ctwa_extract_status: string | null;
  referral_object_present: number;
  ctwa_clid_key_present: number;
  message_timestamp: string | null;
  /** Intentos de conciliación fallidos; define la espera del siguiente. */
  reconcile_attempts: number;
  next_reconcile_at: string | null;
  link_status: string;
  lead_id: string | null;
  contact_id: string | null;
  kommo_id: number | null;
  tenant_id: string | null;
  project_id: string | null;
  supabase_synced: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Espera antes de reevaluar una fila retenida: 30 s, 1 min, 2 min… hasta 1 h.
 * Evita que filas retenidas de forma permanente bloqueen la cola (orden por id).
 */
export function holdBackoffSeconds(holdCount: number): number {
  const n = Number.isFinite(holdCount) ? Math.max(0, Math.floor(holdCount)) : 0;
  return Math.min(3600, 30 * 2 ** Math.min(n, 7));
}

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

      CREATE TABLE IF NOT EXISTS meta_result_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outbox_event_id INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at TEXT,
        UNIQUE(outbox_event_id, stage),
        FOREIGN KEY(outbox_event_id) REFERENCES outbox_events(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_meta_result_sync_pending
        ON meta_result_sync_outbox(status, next_attempt_at);
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
    if (!names.has('delivery_outcome')) {
      this.db.exec(
        `ALTER TABLE outbox_events ADD COLUMN delivery_outcome TEXT NOT NULL DEFAULT 'backend_accepted'`,
      );
    }
    if (!names.has('hold_count')) {
      this.db.exec(
        `ALTER TABLE outbox_events ADD COLUMN hold_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('010_outbox_hold_backoff')`,
      )
      .run();
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
    if (
      tableNames.has('consent_revocations') &&
      tableNames.has('consent_state')
    ) {
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_cloud_message_receipts (
        wamid TEXT PRIMARY KEY,
        wa_id_normalized TEXT,
        wa_id_raw TEXT NOT NULL,
        phone_number_id TEXT NOT NULL,
        waba_id TEXT NOT NULL,
        has_ctwa INTEGER NOT NULL DEFAULT 0,
        ctwa_clid TEXT,
        referral_source_type TEXT,
        source_id TEXT,
        source_url TEXT,
        field_path TEXT,
        link_status TEXT NOT NULL,
        lead_id TEXT,
        contact_id TEXT,
        kommo_id INTEGER,
        tenant_id TEXT,
        project_id TEXT,
        supabase_synced INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_wa_receipts_link_status
        ON wa_cloud_message_receipts(link_status);
      CREATE INDEX IF NOT EXISTS idx_wa_receipts_wa_id
        ON wa_cloud_message_receipts(wa_id_normalized);
    `);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('007_wa_cloud_message_receipts')`,
      )
      .run();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('009_meta_result_sync_outbox')`,
      )
      .run();

    // Diagnóstico CTWA: distinguir no_referral_object vs clid_absent vs clid_rejected.
    // No almacena cuerpos ni valores de clid adicionales (ctwa_clid ya existía solo si extracted).
    const receiptCols = (
      this.db.prepare(`PRAGMA table_info(wa_cloud_message_receipts)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    if (!receiptCols.includes('ctwa_extract_status')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN ctwa_extract_status TEXT`,
      );
    }
    if (!receiptCols.includes('referral_object_present')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN referral_object_present INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!receiptCols.includes('ctwa_clid_key_present')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN ctwa_clid_key_present INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!receiptCols.includes('message_timestamp')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN message_timestamp TEXT`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('008_wa_cloud_ctwa_extract_diag')`,
      )
      .run();

    if (!receiptCols.includes('reconcile_attempts')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!receiptCols.includes('next_reconcile_at')) {
      this.db.exec(
        `ALTER TABLE wa_cloud_message_receipts ADD COLUMN next_reconcile_at TEXT`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id) VALUES ('011_wa_receipt_reconcile_backoff')`,
      )
      .run();
  }

  insertWaCloudReceipt(input: {
    wamid: string;
    waIdRaw: string;
    waIdNormalized: string | null;
    phoneNumberId: string;
    wabaId: string;
    hasCtwa: boolean;
    ctwaClid: string | null;
    referralSourceType: string | null;
    sourceId: string | null;
    sourceUrl: string | null;
    fieldPath: string | null;
    linkStatus: string;
    ctwaExtractStatus: string;
    referralObjectPresent: boolean;
    ctwaClidKeyPresent: boolean;
    messageTimestamp: string | null;
  }): { inserted: boolean; row: WaCloudReceiptRow } {
    const existing = this.getWaCloudReceipt(input.wamid);
    if (existing) {
      return { inserted: false, row: existing };
    }
    this.db
      .prepare(
        `INSERT INTO wa_cloud_message_receipts (
          wamid, wa_id_normalized, wa_id_raw, phone_number_id, waba_id,
          has_ctwa, ctwa_clid, referral_source_type, source_id, source_url,
          field_path, link_status,
          ctwa_extract_status, referral_object_present, ctwa_clid_key_present,
          message_timestamp
        ) VALUES (
          @wamid, @waIdNormalized, @waIdRaw, @phoneNumberId, @wabaId,
          @hasCtwa, @ctwaClid, @referralSourceType, @sourceId, @sourceUrl,
          @fieldPath, @linkStatus,
          @ctwaExtractStatus, @referralObjectPresent, @ctwaClidKeyPresent,
          @messageTimestamp
        )`,
      )
      .run({
        wamid: input.wamid,
        waIdNormalized: input.waIdNormalized,
        waIdRaw: input.waIdRaw,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        hasCtwa: input.hasCtwa ? 1 : 0,
        ctwaClid: input.ctwaClid,
        referralSourceType: input.referralSourceType,
        sourceId: input.sourceId,
        sourceUrl: input.sourceUrl,
        fieldPath: input.fieldPath,
        linkStatus: input.linkStatus,
        ctwaExtractStatus: input.ctwaExtractStatus,
        referralObjectPresent: input.referralObjectPresent ? 1 : 0,
        ctwaClidKeyPresent: input.ctwaClidKeyPresent ? 1 : 0,
        messageTimestamp: input.messageTimestamp,
      });
    const row = this.getWaCloudReceipt(input.wamid);
    if (!row) {
      throw new Error('wa_receipt_insert_missing');
    }
    return { inserted: true, row };
  }

  getWaCloudReceipt(wamid: string): WaCloudReceiptRow | null {
    const row = this.db
      .prepare(`SELECT * FROM wa_cloud_message_receipts WHERE wamid = ?`)
      .get(wamid) as WaCloudReceiptRow | undefined;
    return row || null;
  }

  updateWaCloudReceiptLink(
    wamid: string,
    patch: {
      linkStatus: string;
      leadId?: string | null;
      contactId?: string | null;
      kommoId?: number | null;
      tenantId?: string | null;
      projectId?: string | null;
      supabaseSynced?: boolean;
      lastError?: string | null;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE wa_cloud_message_receipts
         SET link_status = @linkStatus,
             lead_id = COALESCE(@leadId, lead_id),
             contact_id = COALESCE(@contactId, contact_id),
             kommo_id = COALESCE(@kommoId, kommo_id),
             tenant_id = COALESCE(@tenantId, tenant_id),
             project_id = COALESCE(@projectId, project_id),
             supabase_synced = COALESCE(@supabaseSynced, supabase_synced),
             last_error = @lastError,
             updated_at = datetime('now')
         WHERE wamid = @wamid`,
      )
      .run({
        wamid,
        linkStatus: patch.linkStatus,
        leadId: patch.leadId ?? null,
        contactId: patch.contactId ?? null,
        kommoId: patch.kommoId ?? null,
        tenantId: patch.tenantId ?? null,
        projectId: patch.projectId ?? null,
        supabaseSynced:
          typeof patch.supabaseSynced === 'boolean'
            ? patch.supabaseSynced
              ? 1
              : 0
            : null,
        lastError: patch.lastError ?? null,
      });
    return result.changes > 0;
  }

  /**
   * Recibos CTWA por conciliar cuya espera venció. Incluye filas antiguas que
   * quedaron `linked` sin sincronizar con el CRM. Las filas que no casan
   * esperan cada vez más: no acaparan el lote ni se reintentan sin fin.
   */
  listPendingWaCloudReceipts(
    limit = 50,
    nowIso = new Date().toISOString(),
  ): WaCloudReceiptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM wa_cloud_message_receipts
         WHERE has_ctwa = 1
           AND (
             link_status IN ('pending_link', 'pending_ambiguous', 'sync_failed')
             OR (link_status = 'linked' AND supabase_synced = 0)
           )
           AND (next_reconcile_at IS NULL OR next_reconcile_at <= @now)
         ORDER BY COALESCE(next_reconcile_at, created_at) ASC
         LIMIT @limit`,
      )
      .all({
        now: nowIso,
        limit: Math.max(1, Math.min(200, limit)),
      }) as WaCloudReceiptRow[];
  }

  /**
   * Programa el siguiente intento de conciliación (1 min, 2 min… hasta 6 h).
   * Tras `maxAttempts` deja la fila `unlinked_expired` (visible en health).
   */
  scheduleWaReceiptReconcileRetry(wamid: string, maxAttempts = 30): string {
    const row = this.getWaCloudReceipt(wamid);
    if (!row) return 'missing';
    const attempts = Number(row.reconcile_attempts || 0) + 1;
    if (attempts >= maxAttempts) {
      this.db
        .prepare(
          `UPDATE wa_cloud_message_receipts
           SET link_status = 'unlinked_expired',
               reconcile_attempts = @attempts,
               next_reconcile_at = NULL,
               updated_at = datetime('now')
           WHERE wamid = @wamid`,
        )
        .run({ wamid, attempts });
      return 'unlinked_expired';
    }
    const delaySec = Math.min(6 * 3600, 60 * 2 ** Math.min(attempts - 1, 20));
    this.db
      .prepare(
        `UPDATE wa_cloud_message_receipts
         SET reconcile_attempts = @attempts,
             next_reconcile_at = @next,
             updated_at = datetime('now')
         WHERE wamid = @wamid`,
      )
      .run({
        wamid,
        attempts,
        next: new Date(Date.now() + delaySec * 1000).toISOString(),
      });
    return row.link_status;
  }

  countsWaCloudReceipts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT link_status AS status, COUNT(*) AS c
         FROM wa_cloud_message_receipts
         GROUP BY link_status`,
      )
      .all() as Array<{ status: string; c: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.c;
    return out;
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

  tryAcquireLock(lockName: string, ownerId: string, ttlMs: number): boolean {
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
        .prepare(
          `SELECT owner_id, expires_at FROM worker_locks WHERE lock_name = ?`,
        )
        .get(lockName) as { owner_id: string; expires_at: string } | undefined;
      if (!row) return false;
      if (row.expires_at <= nowIso) {
        this.db
          .prepare(`DELETE FROM worker_locks WHERE lock_name = ?`)
          .run(lockName);
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
    const applied = this.applyConsentState(
      scopeType,
      key,
      false,
      consentVersion,
      now,
    );
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
      if (existing)
        return { inserted: false, row: existing, blocked_by_consent: true };

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

  claimPending(
    limit: number,
    deliveryLane: DeliveryLane,
    opts?: {
      excludeSchedule?: boolean;
      excludeLeadSubmitted?: boolean;
      excludeQualifiedLead?: boolean;
      excludePurchase?: boolean;
    },
  ): OutboxRow[] {
    const nowIso = new Date().toISOString();
    const excludeSchedule = opts?.excludeSchedule === true;
    const excludeLeadSubmitted = opts?.excludeLeadSubmitted === true;
    const excludeQualifiedLead = opts?.excludeQualifiedLead === true;
    const excludePurchase = opts?.excludePurchase === true;
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_events
           WHERE status IN ('pending', 'failed')
             AND delivery_lane = @lane
             AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
             AND (@excludeSchedule = 0 OR event_name != 'Schedule')
             AND (@excludeLeadSubmitted = 0 OR event_name != 'LeadSubmitted')
             AND (@excludeQualifiedLead = 0 OR event_name != 'QualifiedLead')
             AND (@excludePurchase = 0 OR event_name != 'Purchase')
           ORDER BY id ASC
           LIMIT @limit`,
        )
        .all({
          now: nowIso,
          limit,
          lane: deliveryLane,
          excludeSchedule: excludeSchedule ? 1 : 0,
          excludeLeadSubmitted: excludeLeadSubmitted ? 1 : 0,
          excludeQualifiedLead: excludeQualifiedLead ? 1 : 0,
          excludePurchase: excludePurchase ? 1 : 0,
        }) as OutboxRow[];

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

  /**
   * Devuelve processing → pending sin perder la fila (gate de entrega,
   * consentimiento, credencial…). Revierte el attempt_count del claim para no
   * empujar a dead por el gate y aplaza el siguiente intento con espera
   * creciente: una fila retenida no vuelve a ocupar el lote en cada tick.
   */
  releaseProcessingToPending(
    id: number,
    reason: string,
    opts?: { retryAfterSec?: number },
  ): boolean {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT hold_count FROM outbox_events WHERE id = ? AND status = 'processing'`,
        )
        .get(id) as { hold_count: number } | undefined;
      if (!row) return false;
      const delaySec =
        opts?.retryAfterSec ?? holdBackoffSeconds(Number(row.hold_count));
      const next = new Date(Date.now() + delaySec * 1000).toISOString();
      const result = this.db
        .prepare(
          `UPDATE outbox_events
           SET status = 'pending',
               attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
               hold_count = hold_count + 1,
               last_error = @reason,
               next_attempt_at = @next,
               updated_at = datetime('now')
           WHERE id = @id AND status = 'processing'`,
        )
        .run({ id, reason: reason.slice(0, 200), next });
      return result.changes === 1;
    })();
  }

  getOutboxById(id: number): OutboxRow | undefined {
    return this.db
      .prepare(`SELECT * FROM outbox_events WHERE id = ?`)
      .get(id) as OutboxRow | undefined;
  }

  /** Última fila por event_id (trazabilidad CRM; no inventa aceptación). */
  getLatestByEventId(eventId: string): OutboxRow | undefined {
    const id = String(eventId || '').trim();
    if (!id) return undefined;
    return this.db
      .prepare(
        `SELECT * FROM outbox_events WHERE event_id = ? ORDER BY id DESC LIMIT 1`,
      )
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
             delivery_outcome = 'meta_accepted',
             meta_response_redacted = @meta
         WHERE id = @id AND status = 'processing'`,
      )
      .run({ id, meta: JSON.stringify(metaResponseRedacted) });
    return result.changes === 1;
  }

  markSentAndQueueResult(
    id: number,
    metaResponseRedacted: unknown,
    syncPayload: Record<string, unknown>,
  ): boolean {
    return this.db.transaction(() => {
      const changed = this.markSent(id, metaResponseRedacted);
      if (!changed) return false;
      this.queueMetaResultSync(id, 'meta_accepted', syncPayload);
      return true;
    })();
  }

  markRetry(
    id: number,
    error: string,
    nextAttemptAt: string,
    dead: boolean,
    deliveryOutcome:
      | 'transport_failed'
      | 'meta_rejected'
      | 'meta_unverified' = 'transport_failed',
    metaResponseRedacted?: unknown,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = @status,
             last_error = @error,
             delivery_outcome = @deliveryOutcome,
             meta_response_redacted = COALESCE(@meta, meta_response_redacted),
             next_attempt_at = @next,
             updated_at = datetime('now')
         WHERE id = @id AND status = 'processing'`,
      )
      .run({
        id,
        status: dead ? 'dead' : 'failed',
        error: error.slice(0, 500),
        next: nextAttemptAt,
        deliveryOutcome,
        meta:
          metaResponseRedacted == null
            ? null
            : JSON.stringify(metaResponseRedacted),
      });
    return result.changes === 1;
  }

  markRetryAndQueueResult(
    id: number,
    error: string,
    nextAttemptAt: string,
    dead: boolean,
    deliveryOutcome: 'transport_failed' | 'meta_rejected' | 'meta_unverified',
    metaResponseRedacted: unknown,
    syncPayload: Record<string, unknown>,
  ): boolean {
    return this.db.transaction(() => {
      const changed = this.markRetry(
        id,
        error,
        nextAttemptAt,
        dead,
        deliveryOutcome,
        metaResponseRedacted,
      );
      if (!changed) return false;
      this.queueMetaResultSync(id, deliveryOutcome, syncPayload);
      return true;
    })();
  }

  queueMetaResultSync(
    outboxEventId: number,
    stage: string,
    payload: Record<string, unknown>,
  ): void {
    const event = this.getOutboxById(outboxEventId);
    if (!event) throw new Error('result_sync_event_missing');
    // next_attempt_at siempre en ISO: se compara como texto con un ISO.
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO meta_result_sync_outbox (
           outbox_event_id, event_id, stage, payload_json, status, next_attempt_at
         ) VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(outbox_event_id, stage) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = 'pending',
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL,
           updated_at = datetime('now')`,
      )
      .run(
        outboxEventId,
        event.event_id,
        stage,
        JSON.stringify(payload),
        nowIso,
      );
  }

  claimMetaResultSync(limit = 20): MetaResultSyncRow[] {
    // Comparación en ISO (mismo formato que markMetaResultSyncRetry). Filas
    // antiguas con datetime('now') ('YYYY-MM-DD HH:MM:SS') siguen siendo
    // reclamables: ' ' ordena antes que 'T'.
    const nowIso = new Date().toISOString();
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM meta_result_sync_outbox
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY id ASC LIMIT ?`,
        )
        .all(nowIso, Math.max(1, Math.min(100, limit))) as MetaResultSyncRow[];
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE meta_result_sync_outbox
             SET attempt_count = attempt_count + 1, updated_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
          )
          .run(row.id);
        row.attempt_count += 1;
      }
      return rows;
    })();
  }

  markMetaResultSynced(id: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE meta_result_sync_outbox
           SET status='sent', sent_at=datetime('now'), updated_at=datetime('now'), last_error=NULL
           WHERE id=? AND status='pending'`,
        )
        .run(id).changes === 1
    );
  }

  markMetaResultSyncRetry(
    id: number,
    error: string,
    nextAttemptAt: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE meta_result_sync_outbox
           SET last_error=?, next_attempt_at=?, updated_at=datetime('now')
           WHERE id=? AND status='pending'`,
        )
        .run(error.slice(0, 300), nextAttemptAt, id).changes === 1
    );
  }

  /** Rechazo permanente: deja de reintentar y conserva el motivo. */
  markMetaResultSyncDead(id: number, error: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE meta_result_sync_outbox
           SET status='dead', last_error=?, updated_at=datetime('now')
           WHERE id=? AND status='pending'`,
        )
        .run(error.slice(0, 300), id).changes === 1
    );
  }

  countsMetaResultSync(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) c FROM meta_result_sync_outbox GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.c]));
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

  /**
   * Cancela Purchase no enviados por sale_id (idempotency purchase:{saleId}).
   * No modifica filas sent (evidencia Graph se conserva).
   */
  cancelPurchaseBySaleId(saleId: string, reason: string): number {
    const id = String(saleId || '').trim();
    if (!id) return 0;
    const key = `purchase:${id}`;
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'cancelled',
             last_error = ?,
             updated_at = datetime('now')
         WHERE event_name = 'Purchase'
           AND idempotency_key = ?
           AND status IN ('pending', 'failed', 'processing', 'dead')`,
      )
      .run(reason.slice(0, 500), key);
    return result.changes;
  }

  /**
   * Purchase ya sent: solo anota last_error; no cambia status ni inventa refund.
   */
  annotatePurchaseAnnulledAfterAccept(saleId: string, note: string): number {
    const id = String(saleId || '').trim();
    if (!id) return 0;
    const key = `purchase:${id}`;
    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET last_error = ?,
             updated_at = datetime('now')
         WHERE event_name = 'Purchase'
           AND idempotency_key = ?
           AND status = 'sent'`,
      )
      .run(note.slice(0, 500), key);
    return result.changes;
  }

  /**
   * Cancela por event_id sin borrar la fila (conserva registro / graph_payload).
   * Afecta pending|failed|processing|dead — no sent ni ya cancelled.
   */
  cancelByEventIds(
    eventIds: string[],
    reason = 'core_setup_hold',
  ): {
    updated: number;
    rows: Array<{ id: number; event_id: string; status: string }>;
  } {
    const ids = [...new Set(eventIds.map((e) => e.trim()).filter(Boolean))];
    if (!ids.length) return { updated: 0, rows: [] };

    const placeholders = ids.map(() => '?').join(',');
    const before = this.db
      .prepare(
        `SELECT id, event_id, status FROM outbox_events
         WHERE event_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: number; event_id: string; status: string }>;

    const result = this.db
      .prepare(
        `UPDATE outbox_events
         SET status = 'cancelled',
             last_error = ?,
             updated_at = datetime('now')
         WHERE event_id IN (${placeholders})
           AND status IN ('pending', 'failed', 'processing', 'dead')`,
      )
      .run(reason.slice(0, 500), ...ids);

    return { updated: result.changes, rows: before };
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

  /**
   * Conteo operativo por evento/canal/dataset/carril/estado, total y últimos 7
   * días (por event_time). Agregado en SQLite: no carga los payloads en memoria.
   * Canal = data[0].messaging_channel, o action_source si no hay; si no es
   * texto o el JSON es inválido → 'unknown'.
   */
  deliveryBreakdown(): Array<{
    event_name: string;
    channel: string;
    dataset_id: string;
    delivery_lane: string;
    status: string;
    delivery_outcome: string;
    window: 'all' | 'last_7d';
    count: number;
  }> {
    const nowMs = Date.now();
    const rows = this.db
      .prepare(
        `SELECT event_name, channel, dataset_id, delivery_lane, status,
                delivery_outcome,
                COUNT(*) AS total,
                SUM(CASE WHEN event_time * 1000 >= @cutoff
                          AND event_time * 1000 <= @now THEN 1 ELSE 0 END) AS recent
         FROM (
           SELECT event_name, dataset_id, delivery_lane, status,
                  delivery_outcome, event_time,
                  CASE
                    WHEN NOT json_valid(graph_payload) THEN 'unknown'
                    WHEN COALESCE(json_type(graph_payload, '$.data[0].messaging_channel'), 'null') <> 'null'
                      THEN CASE
                        WHEN json_type(graph_payload, '$.data[0].messaging_channel') = 'text'
                          THEN json_extract(graph_payload, '$.data[0].messaging_channel')
                        ELSE 'unknown'
                      END
                    WHEN json_type(graph_payload, '$.data[0].action_source') = 'text'
                      THEN json_extract(graph_payload, '$.data[0].action_source')
                    ELSE 'unknown'
                  END AS channel
           FROM outbox_events
         )
         GROUP BY event_name, channel, dataset_id, delivery_lane, status,
                  delivery_outcome
         ORDER BY event_name, channel, dataset_id, delivery_lane, status,
                  delivery_outcome`,
      )
      .all({ cutoff: nowMs - 7 * 24 * 60 * 60 * 1000, now: nowMs }) as Array<{
      event_name: string;
      channel: string;
      dataset_id: string;
      delivery_lane: string;
      status: string;
      delivery_outcome: string;
      total: number;
      recent: number;
    }>;
    const out: ReturnType<SqliteOutboxStore['deliveryBreakdown']> = [];
    for (const row of rows) {
      const base = {
        event_name: String(row.event_name),
        channel: String(row.channel),
        dataset_id: String(row.dataset_id),
        delivery_lane: String(row.delivery_lane),
        status: String(row.status),
        delivery_outcome: String(row.delivery_outcome),
      };
      out.push({ ...base, window: 'all', count: Number(row.total) });
      if (Number(row.recent) > 0) {
        out.push({ ...base, window: 'last_7d', count: Number(row.recent) });
      }
    }
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

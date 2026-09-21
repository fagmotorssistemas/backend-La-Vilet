import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  SqliteOutboxStore,
  type DeliveryLane,
  type OutboxRow,
  type WaCloudReceiptRow,
} from './sqlite-store';

export type { OutboxRow, DeliveryLane, WaCloudReceiptRow };

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;
  private store!: SqliteOutboxStore;
  private resolvedDbPath = '';

  constructor(private readonly config: ConfigService) {}

  get databasePath(): string {
    return this.resolvedDbPath;
  }

  get sqlite(): SqliteOutboxStore {
    return this.store;
  }

  onModuleInit() {
    const dbPath =
      this.config.get<string>('DATABASE_PATH') ||
      path.join(process.cwd(), 'data', 'lavilet-meta-capi.db');
    this.resolvedDbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.resolvedDbPath), { recursive: true });
    this.db = new Database(this.resolvedDbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.store = new SqliteOutboxStore(this.db);
    this.store.migrate();
    const recovered = this.store.recoverStuckProcessing();
    this.store.releaseExpiredLocks();
    if (recovered > 0) {
      this.logger.warn(
        `Recuperadas ${recovered} filas stuck en processing (reinicio/crash)`,
      );
    }
    this.logger.log(`SQLite listo: ${this.resolvedDbPath}`);
  }

  onModuleDestroy() {
    try {
      this.db?.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore
    }
    this.db?.close();
  }

  insertOutbox(
    input: Parameters<SqliteOutboxStore['insertOutbox']>[0],
  ): ReturnType<SqliteOutboxStore['insertOutbox']> {
    return this.store.insertOutbox(input);
  }

  claimPending(
    limit: number,
    deliveryLane: DeliveryLane,
    opts?: { excludeSchedule?: boolean; excludeLeadSubmitted?: boolean },
  ): OutboxRow[] {
    return this.store.claimPending(limit, deliveryLane, opts);
  }

  releaseProcessingToPending(id: number, reason: string): boolean {
    return this.store.releaseProcessingToPending(id, reason);
  }

  markSent(id: number, metaResponseRedacted: unknown): boolean {
    return this.store.markSent(id, metaResponseRedacted);
  }

  markRetry(
    id: number,
    error: string,
    nextAttemptAt: string,
    dead: boolean,
  ): boolean {
    return this.store.markRetry(id, error, nextAttemptAt, dead);
  }

  getOutboxById(id: number) {
    return this.store.getOutboxById(id);
  }

  cancelProcessingIfRevoked(id: number): boolean {
    return this.store.cancelProcessingIfRevoked(id);
  }

  cancelByEventIds(eventIds: string[], reason?: string) {
    return this.store.cancelByEventIds(eventIds, reason);
  }

  countsByStatus(): Record<string, number> {
    return this.store.countsByStatus();
  }

  purgeOld(retentionDays: number) {
    this.store.purgeOld(retentionDays);
  }

  revokeConsent(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
    consentVersion: number,
  ): number {
    return this.store.revokeConsent(scopeType, scopeKey, consentVersion);
  }

  grantConsent(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
    consentVersion: number,
  ): boolean {
    return this.store.grantConsent(scopeType, scopeKey, consentVersion);
  }

  cancelPendingForScope(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
  ): number {
    return this.store.cancelPendingForScope(scopeType, scopeKey);
  }

  getConsentVersion(
    scopeType: 'visitor' | 'lead',
    scopeKey: string,
  ): number | null {
    return this.store.getConsentVersion(scopeType, scopeKey);
  }

  isConsentRevoked(opts: {
    visitorKey?: string | null;
    leadId?: string | null;
  }): boolean {
    return this.store.isConsentRevoked(opts);
  }

  tryAcquireLock(lockName: string, ownerId: string, ttlMs: number): boolean {
    return this.store.tryAcquireLock(lockName, ownerId, ttlMs);
  }

  releaseLock(lockName: string, ownerId: string) {
    this.store.releaseLock(lockName, ownerId);
  }

  insertWaCloudReceipt(
    input: Parameters<SqliteOutboxStore['insertWaCloudReceipt']>[0],
  ) {
    return this.store.insertWaCloudReceipt(input);
  }

  getWaCloudReceipt(wamid: string) {
    return this.store.getWaCloudReceipt(wamid);
  }

  updateWaCloudReceiptLink(
    wamid: string,
    patch: Parameters<SqliteOutboxStore['updateWaCloudReceiptLink']>[1],
  ) {
    return this.store.updateWaCloudReceiptLink(wamid, patch);
  }

  listPendingWaCloudReceipts(limit?: number) {
    return this.store.listPendingWaCloudReceipts(limit);
  }

  countsWaCloudReceipts() {
    return this.store.countsWaCloudReceipts();
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from './sqlite-store';

function tempDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `lv-sqlite-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  const raw = new Database(dbPath);
  const store = new SqliteOutboxStore(raw);
  store.migrate();
  return {
    store,
    close() {
      raw.close();
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
      for (const s of ['-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + s);
        } catch {
          // ignore
        }
      }
    },
  };
}

describe('SqliteOutboxStore comportamiento', () => {
  it('lanes: claim solo de la lane activa', () => {
    const { store, close } = tempDb();
    try {
      store.insertOutbox({
        idempotency_key: 'k-test',
        event_id: '11111111-1111-4111-8111-111111111111',
        event_name: 'Lead',
        event_time: 1_700_000_000,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'test',
        visitor_key: 'v1',
        lead_id: '22222222-2222-4222-8222-222222222222',
      });
      store.insertOutbox({
        idempotency_key: 'k-live',
        event_id: '33333333-3333-4333-8333-333333333333',
        event_name: 'Lead',
        event_time: 1_700_000_001,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: 'v2',
        lead_id: '44444444-4444-4444-8444-444444444444',
      });
      expect(store.claimPending(10, 'live')).toHaveLength(1);
      expect(store.claimPending(10, 'test')[0].idempotency_key).toBe('k-test');
    } finally {
      close();
    }
  });

  it('retirada de consentimiento cancela pendientes en Nest y bloquea evento atrasado', () => {
    const { store, close } = tempDb();
    try {
      const leadId = '55555555-5555-4555-8555-555555555555';
      const visitor = 'anon-visitor-1';
      store.insertOutbox({
        idempotency_key: 'view:anon',
        event_id: '66666666-6666-4666-8666-666666666666',
        event_name: 'ViewContent',
        event_time: 1_700_000_010,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: visitor,
      });
      store.insertOutbox({
        idempotency_key: `lead:${leadId}`,
        event_id: '77777777-7777-4777-8777-777777777777',
        event_name: 'Lead',
        event_time: 1_700_000_011,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: visitor,
        lead_id: leadId,
      });

      const cancelled =
        store.revokeConsent('visitor', visitor) +
        store.revokeConsent('lead', leadId);
      expect(cancelled).toBeGreaterThanOrEqual(2);
      expect(store.claimPending(10, 'live')).toHaveLength(0);

      const late = store.insertOutbox({
        idempotency_key: 'late-lead',
        event_id: '88888888-8888-4888-8888-888888888888',
        event_name: 'Lead',
        event_time: 1_700_000_099,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: visitor,
        lead_id: leadId,
      });
      expect(late.blocked_by_consent).toBe(true);
      expect(late.row.status).toBe('cancelled');
      expect(store.claimPending(10, 'live')).toHaveLength(0);
    } finally {
      close();
    }
  });

  it('caída/recuperación DO: lock caducado se libera y drain puede continuar sin tráfico web', () => {
    const { store, close } = tempDb();
    try {
      const ownerA = 'worker-a';
      const ownerB = 'worker-b';
      expect(store.tryAcquireLock('supabase_drain', ownerA, 30_000)).toBe(true);
      expect(store.tryAcquireLock('supabase_drain', ownerB, 30_000)).toBe(false);

      // Simula reinicio: lock expirado → otro worker puede continuar el drain
      store.forceExpireLock(
        'supabase_drain',
        new Date(Date.now() - 60_000).toISOString(),
      );
      expect(store.tryAcquireLock('supabase_drain', ownerB, 30_000)).toBe(true);

      // Evento pending en Nest se reclama tras “recuperación” (sin nuevos visitantes)
      store.insertOutbox({
        idempotency_key: 'drain-pending',
        event_id: '99999999-9999-4999-8999-999999999999',
        event_name: 'Lead',
        event_time: 1_700_000_200,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        lead_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      const claimed = store.claimPending(5, 'live');
      expect(claimed).toHaveLength(1);
      expect(claimed[0].idempotency_key).toBe('drain-pending');
      store.releaseLock('supabase_drain', ownerB);
    } finally {
      close();
    }
  });
});

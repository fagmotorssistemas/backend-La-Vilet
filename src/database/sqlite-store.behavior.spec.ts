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
        store.revokeConsent('visitor', visitor, 200) +
        store.revokeConsent('lead', leadId, 200);
      expect(cancelled).toBeGreaterThanOrEqual(2);
      expect(store.claimPending(10, 'live')).toHaveLength(0);

      // Grant atrasado no reactiva
      expect(store.grantConsent('visitor', visitor, 100)).toBe(false);
      expect(store.isConsentRevoked({ visitorKey: visitor })).toBe(true);

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
    } finally {
      close();
    }
  });

  it('markSent/markRetry no sobrescriben cancelación concurrente', () => {
    const { store, close } = tempDb();
    try {
      store.insertOutbox({
        idempotency_key: 'proc-1',
        event_id: '99999999-9999-4999-8999-999999999999',
        event_name: 'Lead',
        event_time: 1_700_000_200,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: 'v-x',
        lead_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      const claimed = store.claimPending(1, 'live');
      expect(claimed).toHaveLength(1);
      store.revokeConsent('visitor', 'v-x', 500);
      store.cancelProcessingIfRevoked(claimed[0].id);
      expect(store.markSent(claimed[0].id, { ok: true })).toBe(false);
      expect(store.markRetry(claimed[0].id, 'x', new Date().toISOString(), false)).toBe(
        false,
      );
      expect(store.getOutboxById(claimed[0].id)?.status).toBe('cancelled');
    } finally {
      close();
    }
  });

  it('drain-like: revoke luego grant con versión mayor se aplica', () => {
    const { store, close } = tempDb();
    try {
      const leadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const visitor = 'drain-visitor';
      // Simula ledger Supabase drenado en orden: v10 revoke, luego v11 grant
      store.revokeConsent('lead', leadId, 10);
      store.revokeConsent('visitor', visitor, 10);
      expect(store.isConsentRevoked({ leadId, visitorKey: visitor })).toBe(true);
      expect(store.grantConsent('visitor', visitor, 9)).toBe(false); // atrasado
      expect(store.grantConsent('lead', leadId, 9)).toBe(false);
      expect(store.isConsentRevoked({ leadId, visitorKey: visitor })).toBe(true);

      expect(store.grantConsent('lead', leadId, 11)).toBe(true);
      expect(store.grantConsent('visitor', visitor, 11)).toBe(true);
      expect(store.isConsentRevoked({ leadId, visitorKey: visitor })).toBe(false);
      expect(store.getConsentVersion('lead', leadId)).toBe(11);
      expect(store.getConsentVersion('visitor', visitor)).toBe(11);

      store.insertOutbox({
        idempotency_key: 'after-grant',
        event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        event_name: 'Lead',
        event_time: 1_700_000_300,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: visitor,
        lead_id: leadId,
      });
      expect(store.claimPending(5, 'live')).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('revokeConsent/grantConsent exigen consent_version persistido', () => {
    const { store, close } = tempDb();
    try {
      expect(() =>
        store.revokeConsent('visitor', 'v', Number.NaN),
      ).toThrow(/consent_version_required/);
      expect(() => store.grantConsent('lead', 'x', 0)).toThrow(
        /consent_version_required/,
      );
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

  it('cancelByEventIds marca cancelled sin borrar', () => {
    const { store, close } = tempDb();
    try {
      store.insertOutbox({
        idempotency_key: 'view:a',
        event_id: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
        event_name: 'ViewContent',
        event_time: 1_700_000_000,
        payload_redacted: {},
        graph_payload: {
          data: [
            {
              event_id: '123ddc30-a6dc-4861-a87e-9ea22cebd313',
              custom_data: { content_name: 'Unidad 208' },
              event_source_url: 'https://preview.example/tour/u',
            },
          ],
        },
        dataset_id: 'ds',
        delivery_lane: 'test',
      });
      store.insertOutbox({
        idempotency_key: 'view:b',
        event_id: '73332442-ad30-41cb-a84e-213062c81807',
        event_name: 'ViewContent',
        event_time: 1_700_000_001,
        payload_redacted: {},
        graph_payload: { data: [{ event_id: '73332442-ad30-41cb-a84e-213062c81807' }] },
        dataset_id: 'ds',
        delivery_lane: 'test',
      });
      const result = store.cancelByEventIds(
        [
          '123ddc30-a6dc-4861-a87e-9ea22cebd313',
          '73332442-ad30-41cb-a84e-213062c81807',
        ],
        'core_setup_hold',
      );
      expect(result.updated).toBe(2);
      expect(store.countsByStatus().cancelled).toBe(2);
      expect(store.claimPending(10, 'test')).toHaveLength(0);
      const stillThere = result.rows.length;
      expect(stillThere).toBe(2);
    } finally {
      close();
    }
  });
});

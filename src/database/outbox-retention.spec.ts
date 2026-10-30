import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteOutboxStore } from './sqlite-store';

function tempDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `lv-retention-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  const raw = new Database(dbPath);
  const store = new SqliteOutboxStore(raw);
  store.migrate();
  const close = () => {
    raw.close();
    for (const s of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + s);
      } catch {
        // ignore
      }
    }
  };
  return { store, raw, close };
}

const LEAD = '22222222-2222-4222-8222-222222222222';
const UNIT = '44444444-4444-4444-8444-444444444444';

function sendOld(
  store: SqliteOutboxStore,
  raw: Database.Database,
  key: string,
  eventName: string,
  payload: Record<string, unknown>,
) {
  const inserted = store.insertOutbox({
    idempotency_key: key,
    event_id: '11111111-1111-4111-8111-111111111111',
    event_name: eventName,
    event_time: 1_790_000_000,
    payload_redacted: payload,
    graph_payload: {
      data: [{ event_name: eventName, user_data: { em: ['h'] } }],
    },
    dataset_id: 'ds',
    delivery_lane: 'live',
    visitor_key: 'v1',
    lead_id: LEAD,
  });
  const [claimed] = store.claimPending(10, 'live');
  store.markSent(claimed.id, { http_status: 200, events_received: 1 });
  raw
    .prepare(
      `UPDATE outbox_events SET sent_at = datetime('now', '-120 days') WHERE id = ?`,
    )
    .run(inserted.row.id);
  return inserted.row.id;
}

describe('retención de la cola (purgeOld)', () => {
  it('adelgaza la fila sin borrarla: la clave sigue siendo duplicate', () => {
    const { store, raw, close } = tempDb();
    try {
      const id = sendOld(store, raw, `lead:${LEAD}`, 'Lead', {
        lead_id: LEAD,
        has_em: true,
      });
      store.purgeOld(90);

      const row = store.getOutboxById(id)!;
      expect(row).toBeDefined();
      expect(row.status).toBe('sent');
      expect(row.graph_payload).toBe('{}');
      expect(JSON.parse(row.payload_redacted)).toMatchObject({
        lead_id: LEAD,
      });
      expect(JSON.parse(row.payload_redacted).has_em).toBeUndefined();

      const again = store.insertOutbox({
        idempotency_key: `lead:${LEAD}`,
        event_id: '55555555-5555-4555-8555-555555555555',
        event_name: 'Lead',
        event_time: 1_790_000_100,
        payload_redacted: {},
        graph_payload: { data: [] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        lead_id: LEAD,
      });
      expect(again.inserted).toBe(false);
    } finally {
      close();
    }
  });

  it('la cascada sigue viendo el Lead y la unidad purgados', () => {
    const { store, raw, close } = tempDb();
    try {
      sendOld(store, raw, `lead:${LEAD}`, 'Lead', { lead_id: LEAD });
      store.purgeOld(90);
      expect(
        store.hasRecentEventForScope({
          eventName: 'Lead',
          leadId: LEAD,
          visitorKey: null,
          unitId: null,
          sinceHours: null,
        }),
      ).toBe(true);
    } finally {
      close();
    }
  });

  it('conserva unit_id y evidence_labels como array', () => {
    const { store, raw, close } = tempDb();
    try {
      const id = sendOld(
        store,
        raw,
        `wa_crm_qualified:${LEAD}`,
        'QualifiedLead',
        {
          lead_id: LEAD,
          unit_id: UNIT,
          temperature: 'tibio',
          evidence_labels: ['pide_visita'],
          qualification_source: 'crm_persisted_evaluation',
        },
      );
      store.purgeOld(90);
      const stored = JSON.parse(store.getOutboxById(id)!.payload_redacted);
      expect(stored).toMatchObject({
        unit_id: UNIT,
        temperature: 'tibio',
        evidence_labels: ['pide_visita'],
        qualification_source: 'crm_persisted_evaluation',
      });
    } finally {
      close();
    }
  });

  it('no toca filas recientes ni pendientes', () => {
    const { store, close } = tempDb();
    try {
      const pending = store.insertOutbox({
        idempotency_key: 'view:v1:u1',
        event_id: '66666666-6666-4666-8666-666666666666',
        event_name: 'ViewContent',
        event_time: 1_790_000_000,
        payload_redacted: { unit_id: 'u1', has_em: true },
        graph_payload: { data: [{ event_name: 'ViewContent' }] },
        dataset_id: 'ds',
        delivery_lane: 'live',
        visitor_key: 'v1',
      });
      store.purgeOld(90);
      const row = store.getOutboxById(pending.row.id)!;
      expect(row.graph_payload).not.toBe('{}');
      expect(JSON.parse(row.payload_redacted).has_em).toBe(true);
    } finally {
      close();
    }
  });
});

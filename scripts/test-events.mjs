/**
 * Script de verificación local de eventos CAPI.
 * Uso: npm run test:events
 */
const base = process.env.CAPI_BASE_URL || 'http://localhost:3010/api';

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log('health', health);

  const eventId = crypto.randomUUID();
  const session = await post('/web-session', {
    session_token: `test_${Date.now()}`,
    fbclid: 'IwAR_test_fbclid_lavilet',
    fbp: 'fb.1.1710000000.1234567890',
  });
  console.log('web-session', session.status, session.json);

  const view = await post('/events/view-content', {
    event_id: eventId,
    event_source_url: 'https://www.lavilett.com/inicio',
    content_ids: ['lavilet-inicio'],
    content_type: 'home_listing',
    content_name: 'La Vilet inicio',
    fbp: 'fb.1.1710000000.1234567890',
    fbclid: 'IwAR_test_fbclid_lavilet',
  });
  console.log('ViewContent', view.status, view.json);

  const leadId = crypto.randomUUID();
  const lead = await post('/events/lead', {
    event_id: leadId,
    phone: '0991234567',
    email: 'prueba.lavilet@example.com',
    first_name: 'Prueba',
    last_name: 'Lavilet',
    event_source_url: 'https://www.lavilett.com/contacto',
    session_token: session.json.session_token,
  });
  console.log('Lead', lead.status, lead.json);

  const scheduleId = crypto.randomUUID();
  const schedule = await post('/events/schedule', {
    event_id: scheduleId,
    phone: '0991234567',
    event_source_url: 'https://www.lavilett.com/contacto',
    session_token: session.json.session_token,
  });
  console.log('Schedule', schedule.status, schedule.json);

  const dup = await post('/events/lead', {
    event_id: leadId,
    phone: '0991234567',
  });
  console.log('Lead dedupe', dup.status, dup.json);

  const ok =
    view.json.ok && lead.json.ok && schedule.json.ok && (dup.json.deduped || dup.json.ok);
  if (!ok) {
    console.error('FALLÓ la verificación de eventos');
    process.exit(1);
  }
  console.log('OK — eventos aceptados (simulado o Meta). Revisar Events Manager si no es simulado.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

# lavilet-meta-capi

Backend NestJS independiente para **Meta Pixel + Conversions API** (La Vilet).

Frontend: Vercel · Backend: **DigitalOcean** (Docker).

## Arquitectura

```
Navegador ── Meta Pixel ──────────────────────────────► Meta
Navegador ──► Next.js (Vercel) /api/meta/* ── secreto ──► lavilet-meta-capi (DigitalOcean)
                                                      outbox SQLite (/data) ──► Meta CAPI
```

- `META_CAPI_ACCESS_TOKEN`, `META_DATASET_ID`, `META_TEST_EVENT_CODE` → **solo DigitalOcean**
- Vercel → `NEXT_PUBLIC_META_PIXEL_ID`, `META_CAPI_BACKEND_URL`, `META_CAPI_INTERNAL_SECRET`

Guía completa de despliegue y migración de variables: [`docs/DEPLOY_DIGITALOCEAN.md`](docs/DEPLOY_DIGITALOCEAN.md).

## Modos

| `META_MODE` | Comportamiento |
|---|---|
| `disabled` (default) | Encola; **no** llama a Graph |
| `test` | Envía con `META_TEST_EVENT_CODE` |
| `live` | Producción. **Bloqueado** si el test code sigue definido |

## Cola persistente

- Tabla `outbox_events` en SQLite (`DATABASE_PATH`, en Docker: `/data/...`)
- Worker en-proceso con backoff y claim atómico
- Recuperación automática de filas `processing` tras reinicio/crash
- Health: `GET /api/health` incluye contadores y estado del worker (sin secretos)

## API

| Método | Ruta | Auth |
|---|---|---|
| GET | `/api/health` | Pública (sin secretos) |
| POST | `/api/v1/events` | `X-Internal-Secret` o `Bearer` |

## Desarrollo local

```bash
cp .env.example .env
npm install
npm run start:dev
npm test && npm run test:e2e && npm run lint && npm run build
```

## Docker

```bash
docker build -t lavilet-meta-capi .
docker compose up -d --build
curl -s http://127.0.0.1:3010/api/health
```

Volumen obligatorio: `/data` (persistencia outbox).

## Activación segura (resumen)

1. DO con `META_MODE=disabled` + volumen `/data` + health OK  
2. Vercel con URL del backend + secreto compartido; quitar token/dataset/test del front  
3. `test` → verificar Events Manager → quitar test code → `live`  
4. Rollback: `META_MODE=disabled`

## Restricciones

Categoría Servicios financieros: sin ingresos, deudas, cédulas, scores ni conversaciones; sin `value` artificial.

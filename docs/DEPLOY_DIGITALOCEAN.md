# Despliegue en DigitalOcean — lavilet-meta-capi

No despliega automáticamente. Esta guía prepara App Platform o un Droplet con Docker.

## Arquitectura (sin cambios)

```
Vercel (Next.js)  --META_CAPI_INTERNAL_SECRET-->  DigitalOcean (lavilet-meta-capi)
     |                                                    |
  Pixel browser                                    outbox SQLite en volumen /data
     |                                                    |
     +-------------------- Meta Graph --------------------+
```

## 1. Persistencia de la cola

- SQLite en `DATABASE_PATH=/data/lavilet-meta-capi.db`
- Montar volumen durable en `/data`
- Worker outbox en el mismo proceso (`OUTBOX_ENABLED=true`)
- Al reiniciar: filas `processing` se recuperan a `pending` (no se pierden `event_id` / `event_time`)

## 2. Health check

- Ruta: `GET /api/health`
- Responde JSON con `ok`, `mode`, flags de config (sin secretos), contadores outbox y estado del worker
- Docker `HEALTHCHECK` y App Platform HTTP health usan esa ruta

## 3. App Platform (recomendado)

1. Crear app desde el repo `lavilet-meta-capi` (Dockerfile en la raíz).
2. HTTP port: `3010` (o `$PORT` si DO lo inyecta; el servicio lee `PORT`).
3. Health check: path `/api/health`, period ~30s.
4. Attach **Persistent Volume** en `/data` (mín. 1 GiB).
5. Configurar env vars (tabla abajo). Arrancar con `META_MODE=disabled`.
6. Verificar `curl https://<app-host>/api/health`.
7. En Vercel, poner `META_CAPI_BACKEND_URL=https://<app-host>/api` y el mismo `META_CAPI_INTERNAL_SECRET`.

## 4. Droplet + Docker Compose

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3010/api/health
```

El volumen `lavilet_capi_data` monta `/data`.

## 5. Migración de variables (sin valores)

### Permanecen / se configuran en Vercel (frontend)

| Variable | Notas |
|---|---|
| `NEXT_PUBLIC_META_PIXEL_ID` | Público. Pixel browser. |
| `META_CAPI_BACKEND_URL` | URL HTTPS del servicio en DO **incluyendo** `/api` (ej. `https://capi.ejemplo.com/api`). Server-only. |
| `META_CAPI_INTERNAL_SECRET` | Mismo valor que en DO. Server-only. Nunca `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_COOKIE_BANNER_ENABLED` | Recomendado `true`. |

### Se configuran en DigitalOcean (backend) — dejar de usar en Vercel

| Variable | Notas |
|---|---|
| `META_CAPI_ACCESS_TOKEN` | Token Meta. Solo en DO. |
| `META_DATASET_ID` | `923439043758658`. Solo en DO. |
| `META_PIXEL_ID` | Mismo ID (opcional si ya está `META_DATASET_ID`). |
| `META_TEST_EVENT_CODE` | Solo en modo `test`. Bloquea `live` si está presente. |
| `META_MODE` | `disabled` → `test` → `live`. |
| `META_CAPI_INTERNAL_SECRET` | Compartido con Vercel. |
| `CORS_ORIGINS` | Orígenes del front (`https://www.lavilett.com`, etc.). |
| `DATABASE_PATH` | `/data/lavilet-meta-capi.db` en contenedor. |
| `OUTBOX_*` / `META_API_VERSION` / `META_HTTP_TIMEOUT_MS` | Operación. |

### Checklist de migración

1. Generar un `META_CAPI_INTERNAL_SECRET` largo y único (no reutilizar el token de Meta).
2. En DO: pegar token Meta, dataset, test code (si aplica), secreto, `META_MODE=disabled`.
3. Desplegar backend; confirmar `/api/health` → `ok: true`, `token_configured`, volumen writable.
4. En Vercel Production: añadir `META_CAPI_BACKEND_URL` + `META_CAPI_INTERNAL_SECRET`; conservar `NEXT_PUBLIC_META_PIXEL_ID`.
5. En Vercel: **eliminar** `META_CAPI_ACCESS_TOKEN`, `META_DATASET_ID`, `META_TEST_EVENT_CODE` (ya no aplican al front).
6. Probar un Lead en staging/test con `META_MODE=test` (no contaminar live).
7. Rollback front: quitar `META_CAPI_BACKEND_URL` o poner backend en `disabled`. Rollback DO: `META_MODE=disabled`.

> Guardar secretos solo en Vercel **no** los copia a DigitalOcean. Hay que cargarlos en ambos lados según la tabla.

## 6. Activación

1. `META_MODE=disabled` + health OK  
2. `META_MODE=test` + `META_TEST_EVENT_CODE` → Events Manager Test Events  
3. Quitar test code → `META_MODE=live`  
4. Rollback: `META_MODE=disabled` (la cola permanece en `/data`)

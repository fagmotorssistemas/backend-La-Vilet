# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3010 \
    DATABASE_PATH=/data/lavilet-meta-capi.db \
    OUTBOX_ENABLED=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 --home /app nestjs \
  && mkdir -p /data \
  && chown nestjs:nestjs /data /app

COPY --from=build --chown=nestjs:nestjs /app/dist ./dist
COPY --from=build --chown=nestjs:nestjs /app/node_modules ./node_modules
COPY --from=build --chown=nestjs:nestjs /app/package.json ./package.json
COPY --from=build --chown=nestjs:nestjs /app/migrations ./migrations
COPY --from=build --chown=nestjs:nestjs /app/scripts/cancel-outbox-by-event-id.mjs ./scripts/cancel-outbox-by-event-id.mjs

USER nestjs
EXPOSE 3010

# Volumen esperado en DigitalOcean: /data (SQLite + WAL persistentes)
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/health').then(async r=>{const j=await r.json().catch(()=>({})); process.exit(r.ok&&j.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# Images of the SubTrack research bench, built from the repository root because both need packages/sync-core.
#   docker compose up --build server                          → target "server"
#   docker compose --profile experiments run --rm sim ...     → target "sim" (needs sim/, Phase 4)
# Debian slim, not Alpine: better-sqlite3 ships prebuilt binaries for glibc.
FROM node:22-bookworm-slim AS core
WORKDIR /app
COPY packages/sync-core/package.json packages/sync-core/package-lock.json packages/sync-core/
RUN npm ci --omit=dev --prefix packages/sync-core
COPY packages/sync-core/src packages/sync-core/src

FROM core AS server
COPY server/package.json server/package-lock.json server/
RUN npm ci --omit=dev --prefix server
COPY server/src server/src
WORKDIR /app/server
ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/subscriptions.json \
    DB_FILE=/data/subtrack.db \
    STRATEGY=lww
VOLUME /data
EXPOSE 3000
# node directly (not npm) so that SIGTERM from "docker compose down" reaches the server.
CMD ["node", "--import", "tsx", "src/index.js"]

FROM core AS sim
COPY sim/package.json sim/package-lock.json sim/
RUN npm ci --prefix sim
COPY sim sim
WORKDIR /app/sim
CMD ["npm", "test"]

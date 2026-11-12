# Reproducible environment for the SubTrack sync server.
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/subscriptions.json
VOLUME /data
EXPOSE 3000

CMD ["node", "src/index.js"]

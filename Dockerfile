# Multi-stage: better-sqlite3 native modülünü builder'da derle, runtime imajını ince tut
FROM node:20-bookworm-slim AS builder
WORKDIR /app
# better-sqlite3 prebuilt glibc binary çekemezse kaynaktan derlenir
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Kalıcı DB — fly.toml [mounts] ile /data volume'üne bağlanır
ENV DB_PATH=/data/rytex.db

EXPOSE 3000

CMD ["node", "src/index.js"]

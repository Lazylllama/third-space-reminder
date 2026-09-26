FROM oven/bun:1.3.11-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# SQLite lives here. Mount a persistent volume at /data (Coolify: Persistent Storage).
RUN mkdir -p /data && chown -R bun:bun /data
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/goblin.sqlite

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]

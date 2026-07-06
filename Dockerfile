# mixapi — Bun runtime, no build step (runs TypeScript directly).
FROM oven/bun:1
WORKDIR /app

# deps first for layer caching (only `hono` at runtime; --production skips devDeps)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# app source
COPY src ./src

# sqlite DB lives on a mounted volume at /data (see docker-compose.yml)
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
ENV DB_PATH=/data/mixapi.sqlite \
    PORT=8080
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]

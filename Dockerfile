# USA TV Next — combined Stremio addon (catalog + EPG meta + streams).
# Build context is the repo root so we can bundle both the Node server and the
# static JSON data (roster + per-channel streams) into the image.

FROM node:20-alpine

# tzdata so explicit timeZone formatting is always correct regardless of host.
RUN apk add --no-cache tzdata

WORKDIR /app

# 1. Install production deps first for better layer caching.
COPY server/package.json ./
RUN npm install --production

# 2. Server source.
COPY server/src ./src

# 3. Bundled static data the server reads as its offline baseline.
#    Only catalog (roster) + stream (per-channel streams) are read at runtime;
#    meta is generated dynamically, so it is intentionally NOT bundled.
COPY catalog ./catalog
COPY stream ./stream

ENV PORT=7001 \
    HOST=0.0.0.0 \
    DATA_ROOT=/app \
    CACHE_DIR=/app/cache \
    TZ=America/Denver \
    NODE_OPTIONS=--max-old-space-size=3072

EXPOSE 7001

# Emergency cache (roster-cache.json + epg-cache.json) should survive restarts.
VOLUME ["/app/cache"]

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
    CMD node -e "fetch('http://localhost:7001/manifest.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

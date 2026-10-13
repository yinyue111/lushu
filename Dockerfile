# syntax=docker/dockerfile:1
# Production image for 可信路书 (trusted-routebook). See docs/deploy.md.

# ---- build: install all deps, build dist/, then drop dev deps ----
FROM node:22-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=1024
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime: node + pruned node_modules + server + dist, non-root ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3080 \
    ROUTEBOOK_DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/server.mjs ./
COPY --from=build --chown=root:root /app/server ./server
COPY --from=build --chown=root:root /app/src ./src
COPY --from=build --chown=root:root /app/scripts ./scripts
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/dist ./dist
# Admin console build (served at /admin only when ADMIN_ENABLED=true). Source maps stay out of the image.
COPY --from=build --chown=root:root /app/dist-admin ./dist-admin
# Build info for /api/health and the admin system page (CI passes these; empty → shown as 「未注入」).
ARG GIT_COMMIT=""
ARG BUILD_TIME=""
ENV APP_COMMIT=$GIT_COMMIT \
    APP_BUILD_TIME=$BUILD_TIME
# The app code is read-only for the runtime user; only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3080)+'/api/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs", "--production"]

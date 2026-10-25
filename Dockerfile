# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Team Tracker (Goyal Workspace) app.
# One container serves the built SPA and the API on PORT (default 5175).
# PostgreSQL and Redis are external (already running on the EC2 host) and are
# configured through environment variables, never baked into the image.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# deps: full dependency tree (dev included), cached on package-lock.json
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------------------
# build: typecheck, build the SPA, bundle the server to plain JS
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Fail the image build on type errors (vite build alone does not typecheck).
RUN npm run typecheck
# Frontend -> /app/dist
RUN npm run build
# Server + its src/domain imports -> a single ESM bundle with external packages.
# esbuild ships with the locked dev dependencies (vite), so no extra install.
RUN npx esbuild server/index.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=esm \
      --packages=external \
      --sourcemap \
      --outfile=dist-server/index.mjs

# ---------------------------------------------------------------------------
# runtime: production dependencies and built artifacts only
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5175 \
    DATA_DIR=/app/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Production dependencies only. --ignore-scripts: no package lifecycle scripts.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# Built SPA and the bundled API. server/index.mjs keeps the repo layout so
# dist/ resolves next to DATA_DIR exactly like in development.
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server/index.mjs /app/dist-server/index.mjs.map ./server/

# Persistent data (uploads/, legacy db.json). Bind mounted by docker-compose.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

# Never run as root.
USER node

EXPOSE 5175

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5175)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node runs as PID 1 and shuts down gracefully on SIGTERM.
CMD ["node", "--enable-source-maps", "server/index.mjs"]

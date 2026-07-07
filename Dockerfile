# DECODE authoritative game server. Two stages:
#   1. build  — install ALL deps and esbuild-BUNDLE server/index.ts (+ the shared
#      src/sim it imports) into one plain-JS file.
#   2. runtime — install only prod deps and run the bundle with plain `node`.
#
# Why bundle instead of running `tsx server/index.ts` directly: tsx transpiles the
# whole TS tree with esbuild on EVERY cold boot (~7s on a fresh machine). With
# auto_start_machines, that boot happens on the first player's connection and made
# the platform health check flap before the process was ready. Pre-bundling moves
# that transpile to build time, so the runtime boot is a sub-second `node` start.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.server.json ./
COPY server ./server
COPY src ./src
# --packages=external keeps node_modules deps (ws, pg, @dimforge/rapier2d-compat with
# its embedded WASM) as normal runtime imports; only our own code is bundled.
RUN npx esbuild server/index.ts --bundle --platform=node --format=esm \
    --packages=external --outfile=dist-server/index.js

FROM node:22-alpine
WORKDIR /app
# runtime deps only (react, react-dom, ws, pg, rapier, tsx-not-needed) — small + fast
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist-server ./dist-server
# migrate.ts resolves ./migrations relative to import.meta.url. In the bundle that
# is /app/dist-server/index.js, so the SQL files must sit next to it (they are NOT
# bundled — they're read at runtime with readdirSync). Without this, boot logs
# "migration failed ... ENOENT .../dist-server/migrations" and records stay disabled.
COPY server/db/migrations ./dist-server/migrations

# Fly/Cloud injects PORT; default 8080. GET /health returns 200.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist-server/index.js"]

# DECODE authoritative game server (Node + tsx). Runs server/index.ts, which
# imports the SHARED src/sim. The client (Vite) deploys separately to Vercel.
#
# `--omit=dev` installs only runtime deps (react, react-dom, ws, tsx) from the
# lockfile — NOT electron/vite/typescript — so the image builds fast and small.
FROM node:22-alpine

WORKDIR /app

# install runtime deps first (cached unless the lockfile changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# the server + the shared sim it imports
COPY tsconfig.server.json ./
COPY server ./server
COPY src ./src

# Fly/Cloud injects PORT; default 8080. GET /health returns 200.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "server:start"]

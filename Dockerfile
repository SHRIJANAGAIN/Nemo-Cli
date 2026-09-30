# Trayambak CLI — production image (Linux-first; Windows/macOS via npm)
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Copy the runtime artefacts straight to the unprivileged `node` user
# (uid 1000, shipped by node:20-slim). The build stage stays root - only
# the stage that actually runs the CLI has to drop privileges.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/README.md ./README.md
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts
# `npm ci` above runs as root and leaves node_modules root-owned: it is
# read-only for the app, which is what we want (no self-mutation of
# installed deps as a non-root user). The directory entry itself goes to
# `node` so the CLI can still drop caches/logs next to its working dir,
# and HOME (/home/node) is already owned by `node` for ~/.trayambak state.
RUN chown node:node /app
# Everything after this line runs unprivileged; a compromised container
# process no longer starts as root.
USER node
# Never run as root: the bundled agent executes shell commands, so a
# container breakout would otherwise hand over host root immediately.
USER node
# Container health: plain node fetch (slim image has no curl). Uses the
# default port — override with --health-* flags or HEALTHCHECK=none.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/apps/cli/src/index.js"]
CMD ["--help"]

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
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/LICENSE ./LICENSE
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts
# Container health: plain node fetch (slim image has no curl). Uses the
# default port — override with --health-* flags or HEALTHCHECK=none.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/apps/cli/src/index.js"]
CMD ["--help"]

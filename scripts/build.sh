#!/usr/bin/env bash
# Build trayambak.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-audit --no-fund
npm run build
echo "trayambak built at dist/packages/cli/src/index.js"

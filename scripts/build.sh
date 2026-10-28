#!/usr/bin/env bash
# Build nemo.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-audit --no-fund
npm run build
echo "nemo built at dist/packages/cli/src/index.js"

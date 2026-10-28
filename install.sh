#!/usr/bin/env bash
# Install nemo (macOS / Linux / WSL / Git Bash).
# Usage: ./install.sh   (or: curl -fsSL <raw-url>/install.sh | bash)
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "error: node >= 18 is required (https://nodejs.org)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "error: npm is required" >&2; exit 1; }

npm install --no-audit --no-fund
npm run build

BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"
ENTRY="$(pwd)/dist/apps/cli/src/index.js"
for name in nemo nemo; do
  printf '#!/usr/bin/env sh\nexec node "%s" "$@"\n' "${ENTRY}" > "${BIN_DIR}/${name}"
  chmod +x "${BIN_DIR}/${name}"
done

echo "Installed nemo + nemo to ${BIN_DIR}"
echo "Make sure ${BIN_DIR} is on your PATH, then run: nemo"

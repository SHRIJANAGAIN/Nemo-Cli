/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// Local install helper. Runs `npm install` and then `npm run build` to set up
// trayambak inside this directory. Use `trayambak` (CMD shim) or the
// `node dist/apps/cli/src/index.js` entry point afterwards.
const { spawnSync } = require("child_process")
const path = require("path")

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run("npm", ["install", "--no-audit", "--no-fund"])
run("npx", ["tsc", "-p", "tsconfig.json"])

process.stdout.write("\ntrayambak is ready.\n")
process.stdout.write("Run it with: trayambak run --model-path <path-to-model.gguf>\n")
process.stdout.write("Project root: " + path.resolve(__dirname, "..") + "\n")

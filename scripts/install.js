/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

// Local install helper. Runs `npm install` and then `npm run build` to set up
// nemo inside this directory. Use `nemo` (CMD shim) or the
// `node dist/apps/cli/src/index.js` entry point afterwards.
const { spawnSync } = require("child_process")
const path = require("path")

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run("npm", ["install", "--no-audit", "--no-fund"])
run("npx", ["tsc", "-p", "tsconfig.json"])

process.stdout.write("\nnemo is ready.\n")
process.stdout.write("Run it with: nemo run --model-path <path-to-model.gguf>\n")
process.stdout.write("Project root: " + path.resolve(__dirname, "..") + "\n")

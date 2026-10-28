/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

// Register nemo globally on this Windows machine using only `setx`
// (built-in, no PowerShell required).
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const projectRoot = path.resolve(__dirname, "..")
const userBin = path.join(os.homedir(), "bin")
fs.mkdirSync(userBin, { recursive: true })

const shimNames = ["nemo.cmd", "nemo-code.cmd"]
for (const shim of shimNames) {
  fs.copyFileSync(path.join(projectRoot, "bin", shim), path.join(userBin, shim))
}

const res = spawnSync("setx", ["NEMO_HOME", projectRoot], { stdio: "inherit" })
if (res.status !== 0) process.exit(res.status ?? 1)

process.stdout.write(`\nInstalled:\n`)
for (const shim of shimNames) {
  process.stdout.write(`  shim:    ${path.join(userBin, shim)}\n`)
}
process.stdout.write(`  NEMO_HOME=${projectRoot}\n`)
process.stdout.write(`\nOpen a NEW cmd window and run:\n  nemo\n  (or the short alias: nemo)\n`)

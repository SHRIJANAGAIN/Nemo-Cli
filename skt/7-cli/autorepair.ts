/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Auto-repair module for TRAYAMBAK CLI.
 * Automatically detects and fixes common bugs.
 */

import * as fs from "fs"
import path from "path"
import { execSync } from "child_process"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const SKT_ROOT = path.join(REPO_ROOT, "skt")

export interface RepairResult {
  fixed: string[]
  failed: string[]
  skipped: string[]
}

/**
 * Run all auto-repair checks and fixes.
 */
export function autoRepair(): RepairResult {
  const result: RepairResult = { fixed: [], failed: [], skipped: [] }

  // Check 1: dist/ folder exists
  const distPath = path.join(REPO_ROOT, "dist")
  if (!fs.existsSync(distPath)) {
    try {
      execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" })
      result.fixed.push("dist/ folder rebuilt")
    } catch {
      result.failed.push("dist/ folder rebuild failed")
    }
  } else {
    result.skipped.push("dist/ folder exists")
  }

  // Check 2: llama.cpp binary
  const llamaBin = path.join(process.env.USERPROFILE || "", ".trayambak", "bin", "llama-server.exe")
  if (!fs.existsSync(llamaBin)) {
    result.failed.push("llama-server.exe not found — run trayambak serve to download")
  } else {
    result.skipped.push("llama-server.exe exists")
  }

  // Check 3: config.json
  const configPath = path.join(process.env.USERPROFILE || "", ".trayambak", "config.json")
  if (!fs.existsSync(configPath)) {
    try {
      const defaultConfig = { baseUrl: "http://localhost:8080", model: "", maxTurns: 50, toolMode: "local" }
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
      result.fixed.push("config.json created with defaults")
    } catch {
      result.failed.push("config.json creation failed")
    }
  } else {
    result.skipped.push("config.json exists")
  }

  // Check 4: memory file
  const memPath = path.join(process.env.USERPROFILE || "", ".trayambak", "memory.json")
  if (!fs.existsSync(memPath)) {
    try {
      fs.writeFileSync(memPath, "[]")
      result.fixed.push("memory.json created")
    } catch {
      result.failed.push("memory.json creation failed")
    }
  } else {
    result.skipped.push("memory.json exists")
  }

  // Log results
  const logPath = path.join(SKT_ROOT, "7-cli", "autorepair.log")
  const logEntry = `[${new Date().toISOString()}] Repair result: ${JSON.stringify(result)}\n`
  fs.appendFileSync(logPath, logEntry)

  return result
}

// Run if executed directly
if (require.main === module) {
  console.log("TRAYAMBAK Auto-Repair v0.3.0")
  console.log("Running diagnostics...")
  const result = autoRepair()
  console.log(`\nFixed: ${result.fixed.length}`)
  result.fixed.forEach((f) => console.log(`  ✓ ${f}`))
  console.log(`\nFailed: ${result.failed.length}`)
  result.failed.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\nSkipped: ${result.skipped.length}`)
  result.skipped.forEach((s) => console.log(`  ○ ${s}`))
}

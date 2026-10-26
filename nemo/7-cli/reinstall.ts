/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reinstall NEMO from scratch.
 * Backs up sessions, wipes config, rebuilds.
 */

import * as fs from "fs"
import path from "path"
import { execSync } from "child_process"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const BACKUP_DIR = path.join(process.env.USERPROFILE || "", ".nemo", "backup")

export function reinstall(): void {
  console.log("NEMO Reinstall v0.3.0")

  // Step 1: Backup sessions
  console.log("Backing up sessions...")
  const convoDir = path.join(REPO_ROOT, "nemo", "8-conversations")
  if (fs.existsSync(convoDir)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.cpSync(convoDir, path.join(BACKUP_DIR, "conversations"), { recursive: true })
    console.log("  ✓ Sessions backed up")
  }

  // Step 2: Wipe config
  console.log("Wiping config...")
  const configPath = path.join(process.env.USERPROFILE || "", ".nemo", "config.json")
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath)
    console.log("  ✓ Config wiped")
  }

  // Step 3: Rebuild
  console.log("Rebuilding...")
  try {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit", timeout: 600_000 })
    console.log("  ✓ Build complete")
  } catch {
    console.log("  ✗ Build failed")
  }

  console.log("\nReinstall complete. Run `nemo` to start.")
}

if (require.main === module) {
  reinstall()
}

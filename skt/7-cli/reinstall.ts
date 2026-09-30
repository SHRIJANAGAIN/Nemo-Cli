/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Reinstall TRAYAMBAK from scratch.
 * Backs up sessions, wipes config, rebuilds.
 */

import * as fs from "fs"
import path from "path"
import { execSync } from "child_process"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const BACKUP_DIR = path.join(process.env.USERPROFILE || "", ".trayambak", "backup")

export function reinstall(): void {
  console.log("TRAYAMBAK Reinstall v0.3.0")

  // Step 1: Backup sessions
  console.log("Backing up sessions...")
  const convoDir = path.join(REPO_ROOT, "skt", "8-conversations")
  if (fs.existsSync(convoDir)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.cpSync(convoDir, path.join(BACKUP_DIR, "conversations"), { recursive: true })
    console.log("  ✓ Sessions backed up")
  }

  // Step 2: Wipe config
  console.log("Wiping config...")
  const configPath = path.join(process.env.USERPROFILE || "", ".trayambak", "config.json")
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

  console.log("\nReinstall complete. Run `trayambak` to start.")
}

if (require.main === module) {
  reinstall()
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Reset TRAYAMBAK to factory settings.
 * WARNING: This will delete all sessions, memory, and config.
 */

import * as fs from "fs"
import path from "path"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const TRAYAMBAK_HOME = path.join(process.env.USERPROFILE || "", ".trayambak")

export function reset(): void {
  console.log("TRAYAMBAK Factory Reset v0.3.0")
  console.log("WARNING: This will delete all data!")

  const targets = [
    path.join(TRAYAMBAK_HOME, "config.json"),
    path.join(TRAYAMBAK_HOME, "memory.json"),
    path.join(REPO_ROOT, "skt", "8-conversations"),
    path.join(REPO_ROOT, "skt", "4-mem", "MEMORY.MD"),
  ]

  for (const target of targets) {
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
        console.log(`  ✓ Deleted ${path.basename(target)}`)
      } catch {
        console.log(`  ✗ Failed to delete ${path.basename(target)}`)
      }
    }
  }

  console.log("\nReset complete. Run `trayambak` to start fresh.")
}

if (require.main === module) {
  reset()
}

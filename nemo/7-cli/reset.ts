/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reset NEMO to factory settings.
 * WARNING: This will delete all sessions, memory, and config.
 */

import * as fs from "fs"
import path from "path"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const NEMO_HOME = path.join(process.env.USERPROFILE || "", ".nemo")

export function reset(): void {
  console.log("NEMO Factory Reset v0.3.0")
  console.log("WARNING: This will delete all data!")

  const targets = [
    path.join(NEMO_HOME, "config.json"),
    path.join(NEMO_HOME, "memory.json"),
    path.join(REPO_ROOT, "nemo", "8-conversations"),
    path.join(REPO_ROOT, "nemo", "4-mem", "MEMORY.MD"),
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

  console.log("\nReset complete. Run `nemo` to start fresh.")
}

if (require.main === module) {
  reset()
}

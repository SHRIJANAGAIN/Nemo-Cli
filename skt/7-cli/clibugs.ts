/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { spawnSync } from "child_process"

export interface BugReport {
  id: string
  description: string
  file?: string
  line?: number
  severity: "low" | "medium" | "high" | "critical"
  status: "open" | "fixed" | "wontfix"
  timestamp: string
}

function bugsFile(): string {
  return path.join(process.cwd(), "skt", "7-cli", "bugs.json")
}

export function loadBugs(): BugReport[] {
  try {
    if (!fs.existsSync(bugsFile())) return []
    return JSON.parse(fs.readFileSync(bugsFile(), "utf8")) as BugReport[]
  } catch {
    return []
  }
}

export function saveBugs(bugs: BugReport[]): void {
  fs.mkdirSync(path.dirname(bugsFile()), { recursive: true })
  fs.writeFileSync(bugsFile(), JSON.stringify(bugs, null, 2), "utf8")
}

export function reportBug(
  description: string,
  file?: string,
  line?: number,
  severity: BugReport["severity"] = "medium",
): BugReport {
  const bug: BugReport = {
    id: `bug_${Date.now().toString(36)}`,
    description,
    file,
    line,
    severity,
    status: "open",
    timestamp: new Date().toISOString(),
  }
  const all = loadBugs()
  all.push(bug)
  saveBugs(all)
  return bug
}

/**
 * Auto-repair: scans dist/ for common issues and attempts fixes.
 * Returns a list of actions taken.
 */
export function autoRepair(): string[] {
  const actions: string[] = []
  const distDir = path.join(process.cwd(), "dist")

  // Check 1: dist exists
  if (!fs.existsSync(distDir)) {
    actions.push("dist/ missing — run: npm run build")
    return actions
  }

  // Check 2: main entry exists
  const mainEntry = path.join(distDir, "apps", "cli", "src", "index")
  if (!fs.existsSync(mainEntry)) {
    actions.push("Main entry missing — rebuilding...")
    const res = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 600_000,
    })
    actions.push(res.status === 0 ? "Build succeeded" : `Build failed: ${res.stderr?.slice(0, 200)}`)
  }

  // Check 3: node_modules present
  if (!fs.existsSync(path.join(process.cwd(), "node_modules"))) {
    actions.push("node_modules missing — run: npm install")
  }

  // Check 4: fix common dist issues (stale flat-layout files)
  const toolsDir = path.join(distDir, "apps", "runtime", "src", "tools")
  if (fs.existsSync(toolsDir)) {
    const stale = ["bash", "edit-file", "read-file", "write-file", "glob", "grep", "list-dir", "fs-walk"]
    for (const s of stale) {
      const f = path.join(toolsDir, s)
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
        actions.push(`Removed stale file: tools/${s}`)
      }
    }
  }

  if (actions.length === 0) actions.push("No issues found — CLI is healthy.")
  return actions
}

export function reinstallTrayambak(): string[] {
  const actions: string[] = []
  actions.push("Reinstalling TRAYAMBAK...")
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 600_000,
  })
  actions.push(install.status === 0 ? "Dependencies installed" : `Install failed: ${install.stderr?.slice(0, 200)}`)
  const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 600_000,
  })
  actions.push(build.status === 0 ? "Build succeeded" : `Build failed: ${build.stderr?.slice(0, 200)}`)
  return actions
}

export function resetTrayambak(full = false): string[] {
  const actions: string[] = []
  const targets = ["dist", "skt/8-conversations", "skt/4-mem/memory.json"]
  if (full)
    targets.push(
      "skt/0-points/points.json",
      "skt/1-errors/mistakes.json",
      "skt/5-eval/evals.json",
      "skt/6-u/rewards.json",
    )

  for (const t of targets) {
    const fullPath = path.join(process.cwd(), t)
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true })
      actions.push(`Removed ${t}`)
    }
  }
  actions.push(full ? "Full reset complete." : "Soft reset complete (points/errors preserved).")
  return actions
}

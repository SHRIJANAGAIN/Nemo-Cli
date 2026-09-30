/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

export interface AutonomousActionPlan {
  headline: string
  reason: string
  prompt: string
  files: string[]
  diff?: string
  suggestedTools: string[]
}

export function detectWorkspaceState(cwd: string = process.cwd()): AutonomousActionPlan {
  let gitDiff = ""
  let gitStatus = ""
  const modifiedFiles: string[] = []

  // 1. Check Git Status & Diffs
  try {
    gitStatus = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }).trim()
    if (gitStatus) {
      for (const line of gitStatus.split("\n")) {
        const file = line.slice(3).trim()
        if (file) modifiedFiles.push(file)
      }
      gitDiff = execSync("git diff HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }).trim()
      if (!gitDiff) {
        gitDiff = execSync("git diff", {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30_000,
        }).trim()
      }
    }
  } catch {
    // Not a git repository or git not available
  }

  // If there are uncommitted changes or active diffs, prioritize parallel review & security verification
  if (gitDiff.length > 0 && modifiedFiles.length > 0) {
    return {
      headline: `Uncommitted modifications detected across ${modifiedFiles.length} file(s)`,
      reason: `Found active diff in: ${modifiedFiles.slice(0, 5).join(", ")}${modifiedFiles.length > 5 ? "..." : ""}`,
      files: modifiedFiles,
      diff: gitDiff,
      suggestedTools: ["trayambak__ParallelReview", "trayambak__Agent"],
      prompt: `Autonomous Action: Inspect and verify modified files in this workspace using parallel specialist subagents.
Run trayambak__ParallelReview on the diff, deduplicate findings across correctness, language-specific pitfalls, and security dimensions, and adversarially verify any critical or high issues before reporting.`,
    }
  }

  // 2. Scan key project indicators
  const keyFiles = ["package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "Makefile"]
  const detectedProjects: string[] = []
  for (const f of keyFiles) {
    if (fs.existsSync(path.join(cwd, f))) {
      detectedProjects.push(f)
    }
  }

  // Check for source files
  const sampleSrcFiles: string[] = []
  const candidateDirs = ["src", "lib", "packages", "apps", "cmd", "pkg"]
  for (const dir of candidateDirs) {
    const p = path.join(cwd, dir)
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      try {
        const list = fs.readdirSync(p).slice(0, 5)
        for (const item of list) {
          sampleSrcFiles.push(path.join(dir, item))
        }
      } catch {
        // ignore
      }
    }
  }

  if (detectedProjects.length > 0 || sampleSrcFiles.length > 0) {
    const projectSummary = detectedProjects.length > 0 ? detectedProjects.join(", ") : "Detected source files"
    return {
      headline: `Active codebase detected (${projectSummary})`,
      reason: `Project structure identified with ${sampleSrcFiles.length} key entry paths`,
      files: sampleSrcFiles,
      suggestedTools: ["trayambak__AgentCatalog", "trayambak__ParallelExecute", "trayambak__RunTeam"],
      prompt: `Autonomous Action: Perform an autonomous engineering health check and architectural review of this workspace.
1. Check project structure, dependencies, and code patterns.
2. Dispatch parallel specialist subagents (architect, code-reviewer, and security-reviewer) to examine the codebase.
3. Identify any silent defects, missing tests, or security concerns, and present concrete verified remediations.`,
    }
  }

  // 3. Fallback: General workspace exploration
  return {
    headline: "Workspace exploration and autonomous task formulation",
    reason: "Workspace opened without active git diffs or standard manifests",
    files: [],
    suggestedTools: ["trayambak__AgentCatalog", "trayambak__Agent"],
    prompt: `Autonomous Action: Explore the current directory, summarize the files present, and identify potential software tasks or improvements using specialist subagents.`,
  }
}

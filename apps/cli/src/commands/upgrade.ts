/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `nemo upgrade [target]` — Shrijan's manual `upgrade` command ported to
 * nemo's plain-stdout CLI style (no @clack prompts). Applies updates for
 * the two actionable install methods:
 *
 *   - git:   fetch, then `git pull --ff-only` (or `git checkout v<target>`),
 *            then `npm install` + `npm run build` (nemo needs a build).
 *   - npm:   `npm install -g <name>@<target|latest>`.
 *   - source (no .git): prints manual-update guidance instead.
 *
 * Everything is stdio-inherited so the user sees git/npm progress live.
 */

import { spawnSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import {
  detectMethod,
  fetchLatestGitVersion,
  fetchLatestNpmVersion,
  findInstallRoot,
  getInstalledVersion,
  isSafeVersion,
} from "../../../runtime/src/update/auto-update.js"

export interface UpgradeOptions {
  /** Explicit target version (with or without a leading v). */
  target?: string
  env?: NodeJS.ProcessEnv
  /** Test seams — location to walk up from and argv used for method detection. */
  startDir?: string
  argvPath?: string
}

/**
 * upgradeCommand reports failures as RETURNED text (not throws), so the CLI
 * dispatcher maps this predicate to a non-zero exit — otherwise every
 * failure ("Upgrade failed: ...") exits 0 and scripts cannot detect it.
 * Only the exact "Upgrade failed:" prefix counts: "already the requested
 * version" and the source-copy guidance are not errors.
 */
export function isUpgradeFailure(output: string): boolean {
  return output.startsWith("Upgrade failed:")
}

interface Step {
  ok: boolean
  note?: string
}

function runInherit(cmd: string, args: string[], cwd: string): Step {
  try {
    const result = spawnSync(cmd, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      // npm ships as npm.cmd on Windows, which Node refuses to spawn directly
      // without a shell (Node 18.20+/20+ CVE hardening).
      shell: process.platform === "win32",
    })
    if (result.error) return { ok: false, note: result.error.message }
    if (result.status !== 0) return { ok: false, note: `${cmd} exited with code ${result.status}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) }
  }
}

function headOf(root: string): string | undefined {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    })
    if (result.status === 0) return (result.stdout || "").trim()
    return undefined
  } catch {
    return undefined
  }
}

function finishBuild(root: string): Step {
  // cwd alone selects the project — no --prefix argument, so install paths
  // containing spaces never pass through a shell unquoted.
  const install = runInherit("npm", ["install", "--no-audit", "--no-fund"], root)
  if (!install.ok) return install
  return runInherit("npm", ["run", "build"], root)
}

function readVersion(root: string): string | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }
    return typeof json.version === "string" ? json.version : undefined
  } catch {
    return undefined
  }
}

export async function upgradeCommand(opts: UpgradeOptions = {}): Promise<string> {
  const env = opts.env ?? process.env
  const root = findInstallRoot({ startDir: opts.startDir, env })
  if (!root) {
    return "Upgrade failed: could not locate the nemo installation (set NEMO_HOME to the project root)."
  }
  const current = getInstalledVersion({ startDir: opts.startDir, env }) ?? "unknown"
  const method = detectMethod(root, opts.argvPath ?? process.argv[1] ?? "")
  const target = opts.target?.replace(/^v/, "")

  // Input validation (#66): a target flows into `git checkout v<target>` and
  // `npm install …@<target>` (spawned with shell: true on Windows) — accept
  // plain semver tokens only, before any branch runs a command.
  if (target !== undefined && !isSafeVersion(target)) {
    return `Upgrade failed: invalid target version "${opts.target}" (expected X.Y.Z[-prerelease][+build]).`
  }

  if (method === "source" || method === "unknown") {
    return [
      `nemo ${current} is installed from a source copy without git — it cannot be updated in place.`,
      "Update manually:",
      "  1. Refresh your copy (git pull, or re-download the release)",
      "  2. npm install",
      "  3. npm run build",
      "Or reinstall with: node scripts/install-global.js",
    ].join("\n")
  }

  const pkgName = (() => {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown }
      return typeof json.name === "string" ? json.name : "Nemo"
    } catch {
      return "Nemo"
    }
  })()

  if (method === "npm") {
    // `latest` is either the already-validated `target` or comes back from
    // fetchLatestNpmVersion, which only returns isSafeVersion tokens (#66).
    const latest = target ?? (await fetchLatestNpmVersion(pkgName))
    if (!latest) return "Upgrade failed: could not reach the npm registry."
    if (latest === current) return `nemo ${current} is already the latest version.`
    process.stdout.write(`Upgrading nemo ${current} → ${latest} (npm)...\n`)
    const step = runInherit("npm", ["install", "-g", `${pkgName}@${latest}`], root)
    if (!step.ok) return `Upgrade failed: ${step.note}`
    return `Upgrade complete: ${current} → ${latest}. Restart nemo to use the new version.`
  }

  // method === "git"
  if (target) {
    const wanted = `v${target}`
    if (target === current) return `nemo ${current} is already the requested version.`
    process.stdout.write(`Fetching tags...\n`)
    const fetch = runInherit("git", ["fetch", "origin", "--tags", "--quiet"], root)
    if (!fetch.ok) return `Upgrade failed: could not fetch from origin (${fetch.note}).`
    process.stdout.write(`Checking out ${wanted}...\n`)
    const checkout = runInherit("git", ["checkout", wanted], root)
    if (!checkout.ok) return `Upgrade failed: git checkout ${wanted} failed (${checkout.note}).`
    const build = finishBuild(root)
    if (!build.ok) return `Upgrade failed: ${build.note}`
    const now = readVersion(root) ?? target
    return `Upgrade complete: ${current} → ${now}. Restart nemo to use the new version.`
  }

  const headBefore = headOf(root)
  process.stdout.write("Pulling latest changes...\n")
  const pull = runInherit("git", ["pull", "--ff-only"], root)
  if (!pull.ok) {
    return `Upgrade failed: git pull --ff-only failed (${pull.note}). Resolve local changes and retry.`
  }
  const headAfter = headOf(root)
  const latest = await fetchLatestGitVersion(root)

  if (headBefore && headAfter && headBefore === headAfter) {
    const hint =
      latest && latest !== current
        ? ` (latest release tag is ${latest}; your checkout is on a branch without new commits)`
        : ""
    return `Already up to date: nemo ${current}.${hint}`
  }

  const build = finishBuild(root)
  if (!build.ok) return `Upgrade failed: ${build.note}`
  const now = readVersion(root) ?? current
  if (now === current) return `Already up to date: nemo ${current}.`
  return `Upgrade complete: ${current} → ${now}. Restart nemo to use the new version.`
}

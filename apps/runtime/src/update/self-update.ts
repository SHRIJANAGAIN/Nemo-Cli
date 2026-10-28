/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Session-end self-update — the "impro keeps the CLI fresh" half of the
 * autonomous harness.
 *
 * The startup check (`checkForUpdate`) only NOTIFIES on git checkouts: pulling
 * and rebuilding under the running TUI is unsafe. The session-end harness
 * child is different — it runs detached, after the TUI exited, owning no
 * terminal — so it is the one place a git checkout can be updated for real.
 *
 * Safety envelope:
 *   - kill switches: `autoupdate: false`, `NEMO_AUTOUPDATE=off|0|false`,
 *     `NEMO_DISABLE_AUTOUPDATE=1`.
 *   - at most one attempt per 24h (marker file), so a broken upstream cannot
 *     turn every session exit into a git/npm/build storm.
 *   - git updates require a CLEAN tree and only ever fast-forward
 *     (`pull --ff-only`); local work is never stashed, reset or discarded.
 *   - every failure is a returned log line, never a throw: the harness child
 *     must still exit cleanly.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  checkForUpdate,
  detectMethod,
  findInstallRoot,
  runCapture,
  type UpdateDeps,
} from "./auto-update.js"

export interface AutoUpdateOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  now?: number
  config?: { autoupdate?: boolean | "notify" }
  /** Test seams — forwarded to checkForUpdate. */
  deps?: UpdateDeps
}

/** One attempt per day. Enough to stay current, too slow to be a nuisance. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

const GIT_FETCH_TIMEOUT_MS = 60_000
const GIT_PULL_TIMEOUT_MS = 120_000
const NPM_INSTALL_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 600_000

export function autoUpdateMarker(home: string = os.homedir()): string {
  return path.join(home, ".nemo", "update", "last-auto.json")
}

function readMarker(home: string): { at: number } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(autoUpdateMarker(home), "utf8")) as { at?: unknown }
    return typeof parsed.at === "number" ? { at: parsed.at } : undefined
  } catch {
    return undefined
  }
}

function writeMarker(home: string, at: number): void {
  try {
    const file = autoUpdateMarker(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ at })}\n`, "utf8")
  } catch {
    /* a missing marker only means we try again next session */
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Empty `git status --porcelain` output = nothing to lose. */
async function treeIsClean(root: string): Promise<boolean> {
  const status = await runCapture("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 20_000 })
  return status.ok && status.out.trim().length === 0
}

/**
 * Fast-forward a git checkout, then reinstall and rebuild. Returns a log line.
 * Never pulls over local changes and never rewrites history.
 */
async function applyGitUpdate(root: string): Promise<string> {
  if (!(await treeIsClean(root))) {
    return "update: skipped (working tree is dirty — run `nemo upgrade` when it is clean)"
  }

  const fetch = await runCapture("git", ["fetch", "--tags", "--prune", "origin"], {
    cwd: root,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
  })
  if (!fetch.ok) return `update: failed (git fetch: ${fetch.err.trim() || fetch.code})`

  const behind = await runCapture("git", ["rev-list", "--count", "HEAD..@{u}"], {
    cwd: root,
    timeoutMs: 20_000,
  })
  if (behind.ok && behind.out.trim() === "0") return "update: already up to date"

  const pull = await runCapture("git", ["pull", "--ff-only"], { cwd: root, timeoutMs: GIT_PULL_TIMEOUT_MS })
  if (!pull.ok) return `update: failed (git pull --ff-only: ${pull.err.trim() || pull.code})`

  // Parent dir is not a dependency of the build: stdin ignored, safe env, hard
  // timeouts. These mirror `upgradeCommand`, minus the interactive stdio.
  const install = await runCapture("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: root,
    timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    shell: process.platform === "win32",
  })
  if (!install.ok) return `update: pulled, but npm install failed (${install.err.trim() || install.code})`

  const build = await runCapture("npm", ["run", "build"], {
    cwd: root,
    timeoutMs: BUILD_TIMEOUT_MS,
    shell: process.platform === "win32",
  })
  if (!build.ok) return `update: pulled, but the rebuild failed (${build.err.trim() || build.code})`

  return "update: CLI updated to the latest release (rebuild finished — it applies next launch)"
}

/**
 * Run the session-end update check/apply. Returns a one-line log entry for
 * `~/.nemo/harness/auto.log`; never throws and never blocks longer than
 * the child's own budget.
 */
export async function autoUpdateSelf(opts: AutoUpdateOptions = {}): Promise<string> {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const now = opts.now ?? Date.now()
  const config = opts.config ?? {}

  try {
    if (config.autoupdate === false) return "update: skipped (autoupdate disabled)"
    if (config.autoupdate === "notify") return "update: skipped (autoupdate: notify)"
    const kill = env.NEMO_DISABLE_AUTOUPDATE
    if (kill && !["0", "false"].includes(kill.toLowerCase())) return "update: skipped (kill switch)"

    const marker = readMarker(home)
    if (marker && now - marker.at < AUTO_UPDATE_INTERVAL_MS) return "update: skipped (checked recently)"

    const root = findInstallRoot({ env })
    if (!root) return "update: skipped (install root not found)"
    const method = detectMethod(root)
    if (method !== "npm" && method !== "git") return `update: skipped (install method: ${method})`

    const outcome = await checkForUpdate({ config, env, deps: opts.deps })
    writeMarker(home, now)

    if (outcome.kind === "updated") return `update: updated ${outcome.previous} -> ${outcome.latest}`
    if (outcome.kind === "up-to-date") return "update: already up to date"
    if (outcome.kind === "skipped") return `update: skipped (${outcome.reason})`
    if (outcome.kind === "error") return `update: failed (${outcome.reason})`
    if (method === "git") return await applyGitUpdate(root)
    return `update: ${outcome.latest} available (${outcome.releaseType}) — run \`nemo upgrade\``
  } catch (error) {
    return `update: failed (${describe(error)})`
  }
}

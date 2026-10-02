/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Auto-update — port of SKT AI LABS's cli/upgrade.ts policy, adapted to trayambak's
 * install reality (source checkout with a build step, not a prebuilt binary):
 *
 *   - `autoupdate: true | false | "notify"` (SKT AI LABS semantics) + the
 *     TRAYAMBAK_DISABLE_AUTOUPDATE kill switch (SKT AI LABS's SKT_AI_LABS_DISABLE_AUTOUPDATE).
 *   - Install-method detection: "npm" (global node_modules install), "git"
 *     (checkout with .git), "source" (manual copy — never updated here).
 *   - Latest-version fetch: npm registry for npm installs, `git ls-remote`
 *     release tags for git installs. Any failure is silent — an update check
 *     must never break boot.
 *   - Release-type gating (SKT AI LABS): only `patch` updates auto-apply when
 *     `autoupdate === true`; minor/major (and everything under "notify")
 *     produce an update-available notice instead.
 *   - Documented deviation: git checkouts NEVER auto-apply (unlike SKT AI LABS's
 *     npm), because updating requires `git pull` + `npm install` + a rebuild
 *     under the running process — they always get the notice and run
 *     `trayambak upgrade` explicitly.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { getSafeEnv } from "../../../../packages/core/src/env_filter.js"

export type UpdateMethod = "npm" | "git" | "source" | "unknown"
export type ReleaseType = "major" | "minor" | "patch" | "unknown"

export type UpdateOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "up-to-date"; current: string }
  | { kind: "update-available"; current: string; latest: string; releaseType: ReleaseType; auto: boolean }
  | { kind: "updated"; previous: string; latest: string }
  | { kind: "error"; reason: string }

/** Injection seam for tests: policy logic stays free of network/process work. */
export interface UpdateDeps {
  method?: UpdateMethod
  fetchLatest?: (method: UpdateMethod) => Promise<string | undefined>
  applyUpdate?: (method: UpdateMethod, latest: string) => Promise<void>
  env?: NodeJS.ProcessEnv
}

const NPM_REGISTRY_TIMEOUT_MS = 5_000
const GIT_LS_REMOTE_TIMEOUT_MS = 10_000
const NPM_APPLY_TIMEOUT_MS = 180_000
const CAPTURE_MAX_BYTES = 1024 * 1024

/** Strict `v?X.Y.Z` parse (prerelease/rc tags are not update candidates). */
export function parseVersion(raw: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * The only shape a version may take before it reaches a shell or a package
 * specifier (#66): `X.Y.Z` with optional `-prerelease`/`+build`, characters
 * limited to alphanumerics, `.`, and `-`. The charset excludes every cmd.exe
 * and sh metacharacter (`& | ; < > ^ " % $ \` ( ) ! space`), so a hostile or
 * corrupted registry response can never become shell syntax — `upgrade.ts`
 * spawns `npm install …@<version>` with `shell: true` on Windows.
 */
export function isSafeVersion(raw: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(raw)
}

/** SKT AI LABS's Installation.getReleaseType port: how `latest` relates to `current`. */
export function getReleaseType(current: string, latest: string): ReleaseType {
  const a = parseVersion(current)
  const b = parseVersion(latest)
  if (!a || !b) return "unknown"
  if (b.major > a.major) return "major"
  if (b.major < a.major) return "unknown"
  if (b.minor > a.minor) return "minor"
  if (b.minor < a.minor) return "unknown"
  if (b.patch > a.patch) return "patch"
  return "unknown"
}

/** How trayambak itself was installed (not the user's project — `cwd` must be
 * the trayambak install root). npm-global wins over an adjacent .git. */
export function detectMethod(cwd: string, argvPath = process.argv[1] ?? ""): UpdateMethod {
  if (/[\\/]node_modules[\\/]/.test(argvPath)) return "npm"
  if (cwd && fs.existsSync(path.join(cwd, ".git"))) return "git"
  if (cwd) return "source"
  return "unknown"
}

function readPackageJson(dir: string): { name?: string; version?: string } | undefined {
  try {
    const file = path.join(dir, "package.json")
    if (!fs.existsSync(file)) return undefined
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; version?: unknown }
    return {
      name: typeof json.name === "string" ? json.name : undefined,
      version: typeof json.version === "string" ? json.version : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Install-root package names: the source tree is "trayambak", but the
 * published npm tarball is "@skt-ai-labs/trayambak-cli" — matching only the
 * former made every production install unlocatable, so checkForUpdate
 * always skipped with "cannot determine installed version" (observed live:
 * auto-update never fired outside dev checkouts).
 */
export function isInstallRootName(name: unknown): boolean {
  if (typeof name !== "string") return false
  const n = name.toLowerCase()
  return n === "trayambak" || n === "@skt-ai-labs/trayambak-cli"
}

/**
 * Locate the trayambak installation root: TRAYAMBAK_HOME first (what the
 * global shim sets), then walk up from the module until a package.json whose
 * name is an install-root name (isInstallRootName: source "trayambak" or
 * published "@skt-ai-labs/trayambak-cli") — the same two-signal root rule
 * the shim uses, so stray
 * package.json files can't hijack version detection. Works from both the
 * source tree and dist/ (walk-up is depth-independent).
 */
export function findInstallRoot(opts?: { startDir?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  const env = opts?.env ?? process.env
  const marker = (dir: string): string | undefined => {
    const pkg = readPackageJson(dir)
    if (isInstallRootName(pkg?.name)) return dir
    return undefined
  }
  const envRoot = env.TRAYAMBAK_HOME
  if (envRoot) {
    const hit = marker(path.resolve(envRoot))
    if (hit) return hit
  }
  const start = opts?.startDir ?? (typeof __dirname !== "undefined" ? __dirname : process.cwd())
  let dir = path.resolve(start)
  for (;;) {
    const hit = marker(dir)
    if (hit) return hit
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Installed version from the install root's package.json (SKT AI LABS's compiled
 * InstallationVersion constant, read at runtime instead). */
export function getInstalledVersion(opts?: { startDir?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  const root = findInstallRoot(opts)
  if (!root) return undefined
  return readPackageJson(root)?.version
}

export interface FetchLikeResponse {
  ok: boolean
  json(): Promise<unknown>
}

/** npm registry `latest` for the package name — undefined on any failure
 * (404 for unpublished names, offline, timeout, malformed body). */
export async function fetchLatestNpmVersion(
  pkgName: string,
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<FetchLikeResponse>,
): Promise<string | undefined> {
  try {
    const doFetch: (url: string, init?: { signal?: AbortSignal }) => Promise<FetchLikeResponse> =
      fetchImpl ?? globalThis.fetch
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName.toLowerCase())}/latest`
    const response = await doFetch(url, { signal: AbortSignal.timeout(NPM_REGISTRY_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: unknown }
    // Origin validation (#66): nothing but a plain semver token leaves this
    // function, so every downstream consumer (shell spawns, npm specifiers,
    // compare logic) starts from a safe value.
    if (typeof body.version !== "string" || !isSafeVersion(body.version)) return undefined
    return body.version
  } catch {
    return undefined
  }
}

interface CaptureResult {
  ok: boolean
  out: string
  err: string
  code: number | null
}

/** Spawn with captured stdout/stderr and a hard timeout (kill on expiry).
 *
 *  Exported for tests. Runs with the filtered env (#79): the npm path runs
 *  `npm install -g <pkg>@<latest>`, i.e. postinstall scripts of the update
 *  and every transitive dependency — package code that must not inherit the
 *  CLI's raw secret-bearing env (same boundary as mcp-install, #77). */
export function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: getSafeEnv(process.env),
      })
    } catch (error) {
      resolve({ ok: false, out: "", err: String(error), code: null })
      return
    }
    let out = ""
    let err = ""
    let settled = false
    const finish = (result: CaptureResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, out, err: `${err}\ntimed out after ${opts.timeoutMs}ms`.trim(), code: null })
    }, opts.timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < CAPTURE_MAX_BYTES) out += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < CAPTURE_MAX_BYTES) err += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      finish({ ok: false, out, err: `${err}${error.message}`, code: null })
    })
    child.on("close", (code) => {
      finish({ ok: code === 0, out, err, code })
    })
  })
}

/** Highest stable `vX.Y.Z` tag in `git ls-remote --tags` output (prerelease
 * and non-version tags are ignored; peeled `^{}` lines tolerated). */
export function parseMaxTagVersion(lsRemoteOutput: string): string | undefined {
  let best: { version: string; parts: [number, number, number] } | undefined
  for (const raw of lsRemoteOutput.split(/\r?\n/)) {
    const match = /refs\/tags\/v?(\d+)\.(\d+)\.(\d+)(?:\^\{\})?$/.exec(raw.trim())
    if (!match) continue
    const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (
      !best ||
      parts[0] > best.parts[0] ||
      (parts[0] === best.parts[0] && parts[1] > best.parts[1]) ||
      (parts[0] === best.parts[0] && parts[1] === best.parts[1] && parts[2] > best.parts[2])
    ) {
      best = { version: parts.join("."), parts }
    }
  }
  return best?.version
}

/** Highest stable release tag on origin — undefined when git is missing, the
 * checkout has no origin remote, or nothing reachable looks like a version. */
export async function fetchLatestGitVersion(cwd: string): Promise<string | undefined> {
  const result = await runCapture("git", ["ls-remote", "--tags", "--refs", "origin"], {
    cwd,
    timeoutMs: GIT_LS_REMOTE_TIMEOUT_MS,
  })
  if (!result.ok) return undefined
  return parseMaxTagVersion(result.out)
}

/**
 * npm executable per platform: on Windows npm is a .cmd shim, which
 * spawn() without a shell cannot launch (ENOENT) — every Windows
 * auto-apply died as an "error" outcome. npm.cmd runs directly.
 */
export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm"
}

async function applyNpmUpdate(root: string, pkgName: string, latest: string): Promise<void> {
  const result = await runCapture(npmCommand(), ["install", "-g", `${pkgName}@${latest}`], {
    cwd: root,
    timeoutMs: NPM_APPLY_TIMEOUT_MS,
  })
  if (!result.ok) {
    throw new Error(result.err.trim() || `npm install exited with code ${result.code}`)
  }
}

export interface CheckForUpdateOptions {
  /** Any object carrying the `autoupdate` policy field (TrayambakConfig fits). */
  config: { autoupdate?: boolean | "notify" }
  env?: NodeJS.ProcessEnv
  /** Module/location to walk up from when locating the install root. */
  startDir?: string
  deps?: UpdateDeps
}

/**
 * SKT AI LABS's `upgrade()` policy, returning an outcome instead of emitting bus
 * events: the TUI turns "update-available" into a transcript notice, the CLI
 * command does explicit upgrades.
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<UpdateOutcome> {
  const env = opts.deps?.env ?? opts.env ?? process.env
  if (opts.config.autoupdate === false) return { kind: "skipped", reason: "autoupdate disabled" }
  if (env.TRAYAMBAK_DISABLE_AUTOUPDATE && !["0", "false"].includes(env.TRAYAMBAK_DISABLE_AUTOUPDATE)) {
    return { kind: "skipped", reason: "TRAYAMBAK_DISABLE_AUTOUPDATE set" }
  }

  const root = findInstallRoot({ startDir: opts.startDir, env })
  const current = root ? readPackageJson(root)?.version : undefined
  if (!root || !current) return { kind: "skipped", reason: "cannot determine installed version" }

  const method = opts.deps?.method ?? detectMethod(root)
  if (method !== "npm" && method !== "git") {
    return { kind: "skipped", reason: `unsupported install method: ${method}` }
  }

  const pkgName = readPackageJson(root)?.name ?? "Trayambak"
  const fetchLatest =
    opts.deps?.fetchLatest ??
    ((m: UpdateMethod): Promise<string | undefined> =>
      m === "npm" ? fetchLatestNpmVersion(pkgName) : fetchLatestGitVersion(root))
  const latest = await fetchLatest(method).catch(() => undefined)
  if (!latest) return { kind: "skipped", reason: "no update source reachable" }

  if (latest === current) return { kind: "up-to-date", current }

  // A local build ahead of the release (dev checkout) is not an "update".
  const cur = parseVersion(current)
  const next = parseVersion(latest)
  if (cur && next) {
    const newer =
      next.major > cur.major ||
      (next.major === cur.major && next.minor > cur.minor) ||
      (next.major === cur.major && next.minor === cur.minor && next.patch > cur.patch)
    if (!newer) return { kind: "up-to-date", current }
  }

  const releaseType = getReleaseType(current, latest)
  // SKT AI LABS gates auto-apply to patches under `autoupdate: true`; we additionally
  // force notify for git checkouts (rebuild-under-running-process is unsafe).
  const notifyOnly = opts.config.autoupdate === "notify" || releaseType !== "patch" || method === "git"
  if (notifyOnly) return { kind: "update-available", current, latest, releaseType, auto: false }

  const apply =
    opts.deps?.applyUpdate ??
    ((m: UpdateMethod, v: string): Promise<void> => {
      if (m !== "npm") return Promise.reject(new Error(`auto-apply unsupported for method: ${m}`))
      return applyNpmUpdate(root, pkgName, v)
    })
  try {
    await apply(method, latest)
    return { kind: "updated", previous: current, latest }
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) }
  }
}

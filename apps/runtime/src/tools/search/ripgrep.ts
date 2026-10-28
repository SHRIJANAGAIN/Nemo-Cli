/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * ripgrep backend shared by the grep, glob, and code_search tools.
 *
 * Why: the pure-Node walker (file-edit/fs-walk.ts) is synchronous,
 * gitignore-unaware, and reads every file line-by-line through the JS
 * event loop. ripgrep is 10-50x faster on real repositories, skips
 * binaries, and respects .gitignore — but it is an OPTIONAL dependency:
 * every call site must keep its Node fallback for machines without rg.
 *
 * Safety contract:
 *  - Never spawns through a shell (args array only — patterns starting
 *    with `-` are passed after `-e` and cannot become flags).
 *  - Output hard-capped at 256KB (repo-wide process-output rule).
 *  - Explicit timeout kill; AbortSignal support.
 *  - `--no-config` for determinism; `--hidden` + the Node walker's
 *    IGNORED_DIRS exclusions for behavioural parity.
 *  - JS-flavored patterns (look-around) are retried once with `--pcre2`
 *    and fall back to the Node engine when rg still rejects them.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { IGNORED_DIRS } from "../file-edit/fs-walk.js"
import { envPathList, envString } from "../../../../../packages/core/src/env_read.js"

/** Hard cap on ripgrep stdout (repo-wide 256KB process-output rule). */
export const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const PCRE2_RETRY_TIMEOUT_MS = 10_000
const MAX_STDERR_BYTES = 8 * 1024

export interface RgHit {
  /** Path relative to the search root, with platform separators. */
  path: string
  /** 1-based line number. */
  line: number
  /** Matched (or context) line text without the trailing newline. */
  text: string
  /** false = context line emitted alongside a match. */
  isMatch: boolean
}

let override: string | null | undefined
let cached: { done: boolean; bin: string | null } = { done: false, bin: null }

/**
 * Backend selection hook.
 * - `string` — force this binary (tests / explicit configuration)
 * - `null` — disable ripgrep entirely (pure-Node fallback)
 * - `undefined` — auto-detect (env override → PATH → editor bundles)
 */
export function setRipgrepOverride(p: string | null | undefined): void {
  override = p
  cached = { done: false, bin: null }
}

export function resolveRipgrep(): string | null {
  if (override !== undefined) return override
  if (!cached.done) cached = { done: true, bin: detect() }
  return cached.bin
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function detect(): string | null {
  // 1. Explicit env override (e.g. NEMO_RG=C:\tools\rg.exe).
  try {
    const envBin = envString("NEMO_RG")
    if (envBin && isFile(envBin)) return envBin
  } catch {
    /* env unreadable — keep probing */
  }
  // 2. PATH scan: rg.exe on Windows (PATHEXT variants), plain `rg` elsewhere.
  try {
    // envPathList splits on the PLATFORM separator and drops empty entries, so the
    // empty-string PATH (`PATH=""`) yields [] instead of one bogus "" entry that
    // every iteration then had to skip.
    const pathDirs = envPathList("PATH")
    const exts =
      process.platform === "win32"
        ? (envString("PATHEXT") ?? ".EXE;.CMD;.BAT")
            .split(";")
            .filter((e): boolean => e.length > 0)
            .map((e: string) => e.toLowerCase())
        : [""]
    for (const dir of pathDirs) {
      if (!dir) continue
      for (const ext of exts) {
        const cand = path.join(dir, `rg${ext}`)
        if (isFile(cand)) return cand
      }
    }
  } catch {
    /* PATH unreadable — keep probing */
  }
  // 3. Editor bundles that ship ripgrep (VS Code + Copilot SDK layouts).
  for (const cand of editorBundles()) {
    if (isFile(cand)) return cand
  }
  return null
}

/** Known locations of the ripgrep binary bundled inside VS Code installs. */
function editorBundles(): string[] {
  const out: string[] = []
  if (process.platform === "win32") {
    const roots: string[] = []
    try {
      const local = envString("LOCALAPPDATA")
      if (local) roots.push(path.join(local, "Programs", "Microsoft VS Code"))
      const pf = envString("ProgramFiles")
      if (pf) roots.push(path.join(pf, "Microsoft VS Code"))
    } catch {
      return out
    }
    for (const root of roots) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        // Versioned install directories (e.g. "04c0d99f4f").
        out.push(
          path.join(
            root,
            e.name,
            "resources",
            "app",
            "node_modules.asar.unpacked",
            "@github",
            "copilot-sdk-win32-x64",
            "ripgrep",
            "bin",
            "win32-x64",
            "rg.exe",
          ),
        )
        out.push(
          path.join(
            root,
            e.name,
            "resources",
            "app",
            "extensions",
            "copilot",
            "node_modules",
            "@github",
            "copilot",
            "sdk",
            "ripgrep",
            "bin",
            "win32-x64",
            "rg.exe",
          ),
        )
      }
    }
  } else if (process.platform === "darwin") {
    out.push(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-x64/ripgrep/bin/darwin-x64/rg",
    )
  } else {
    out.push(
      "/usr/share/code/resources/app/node_modules.asar.unpacked/@github/copilot-sdk-linux-x64/ripgrep/bin/linux-x64/rg",
      "/opt/visual-studio-code/resources/app/node_modules.asar.unpacked/@github/copilot-sdk-linux-x64/ripgrep/bin/linux-x64/rg",
    )
  }
  return out
}

export interface RgQuery {
  /** Directory ripgrep runs in; results are relative to it. */
  cwd: string
  /**
   * What ripgrep searches, relative to `cwd`. Defaults to the whole tree
   * ("."). A file name restricts the search to that single file — passing a
   * FILE as `cwd` instead makes ripgrep fail with ENOTDIR.
   */
  target?: string
  /** Regex (or literal with `fixedStrings`) to search for. */
  pattern?: string
  fixedStrings?: boolean
  ignoreCase?: boolean
  /** Context lines before/after each match (-C). */
  contextLines?: number
  /** Include-glob; ignored when absent or "*". */
  glob?: string
  /** `rg --files` mode (glob tool) instead of a content search. */
  filesOnly?: boolean
}

/**
 * Build the argv for a query. Shared by every call site so the safety
 * flags (`--no-config`, `--hidden`, IGNORED_DIRS exclusions, `-e`) can
 * never be forgotten or overridden by user ripgrep configuration.
 */
export function buildSearchArgs(query: RgQuery): string[] {
  const args: string[] = ["--no-config", "--no-messages", "--hidden"]
  // Same skip list as the Node walker so both backends agree even when
  // the directory is not a git repository.
  for (const dir of IGNORED_DIRS) args.push("--glob", `!${dir}`)
  if (query.filesOnly) {
    args.push("--files")
  } else {
    args.push("--json")
    if (query.pattern !== undefined) args.push("-e", query.pattern)
    if (query.fixedStrings) args.push("--fixed-strings")
    if (query.ignoreCase) args.push("-i")
    if (typeof query.contextLines === "number" && query.contextLines > 0) {
      args.push("-C", String(Math.min(query.contextLines, 10)))
    }
  }
  if (query.glob && query.glob !== "*") args.push("-g", query.glob)
  args.push(query.target ?? ".")
  return args
}

export interface RgRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** stdout hit the 256KB cap; the process was killed to enforce it. */
  bytesTruncated: boolean
  timedOut: boolean
  spawnError: string | null
}

/** Spawn ripgrep without a shell, capped and timed. Never throws. */
export function runRipgrep(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<RgRunResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let bytesTruncated = false
    let timedOut = false
    let done = false
    let child: ReturnType<typeof spawn>

    const settle = (result: Omit<RgRunResult, "stdout" | "stderr" | "bytesTruncated" | "timedOut">): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve({
        ...result,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        bytesTruncated,
        timedOut,
      })
    }

    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      })
    } catch (e) {
      settle({ exitCode: null, spawnError: e instanceof Error ? e.message : String(e) })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const onAbort = (): void => {
      child.kill()
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytesTruncated) return
      const room = maxBytes - outLen
      if (chunk.length >= room) {
        if (room > 0) outChunks.push(chunk.subarray(0, room))
        outLen = maxBytes
        bytesTruncated = true
        child.kill() // partial output is still parseable (see parseRgJson)
      } else {
        outChunks.push(chunk)
        outLen += chunk.length
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errLen >= MAX_STDERR_BYTES) return
      errChunks.push(chunk)
      errLen += chunk.length
    })

    child.on("error", (e) => {
      settle({ exitCode: null, spawnError: e.message })
    })
    child.on("close", (code) => {
      settle({ exitCode: code, spawnError: null })
    })
  })
}

/**
 * Parse ripgrep `--json` events into flat hits. Tolerant by design: a
 * killed process can leave a partial final line, and non-UTF8 paths come
 * back as base64 `bytes` instead of `text` — both are handled or skipped.
 */
export function parseRgJson(stdout: string): RgHit[] {
  const hits: RgHit[] = []
  for (const line of stdout.split("\n")) {
    if (!line) continue
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      continue // truncated tail after a cap/timeout kill
    }
    if (typeof ev !== "object" || ev === null) continue
    const rec = ev as { type?: unknown; data?: unknown }
    if (rec.type !== "match" && rec.type !== "context") continue
    if (typeof rec.data !== "object" || rec.data === null) continue
    const data = rec.data as { path?: unknown; line_number?: unknown; lines?: unknown }
    const rawPath = rgFieldText(data.path)
    const rawLines = rgFieldText(data.lines)
    if (rawPath === null || rawLines === null) continue
    if (typeof data.line_number !== "number") continue
    hits.push({
      path: normalizeRgPath(rawPath),
      line: data.line_number,
      text: rawLines.replace(/\r?\n$/, ""),
      isMatch: rec.type === "match",
    })
  }
  return hits
}

function rgFieldText(field: unknown): string | null {
  if (typeof field !== "object" || field === null) return null
  const f = field as { text?: unknown; bytes?: unknown }
  if (typeof f.text === "string") return f.text
  if (typeof f.bytes === "string") return Buffer.from(f.bytes, "base64").toString("utf8")
  return null
}

/**
 * Normalise a ripgrep-reported path to the shape the Node walker reports:
 * platform separators, no leading `./` or `.\` (rg prints `.\src\a.ts`
 * when the search root is `.`, but `src\a.ts` in `--files` mode).
 */
export function normalizeRgPath(raw: string): string {
  const unified = path.sep === "\\" ? raw.replace(/\//g, "\\") : raw
  return unified.replace(/^\.[\\/]+/, "")
}

export type RgOutcome = { kind: "ok"; hits: RgHit[]; truncated: boolean } | { kind: "failed"; reason: string }

/**
 * Run a search end-to-end. Returns `failed` (→ caller keeps its Node
 * fallback) whenever ripgrep is missing, crashes, times out, or rejects
 * the pattern even after the PCRE2 retry.
 */
export async function searchRipgrep(query: RgQuery, opts: { signal?: AbortSignal } = {}): Promise<RgOutcome> {
  const bin = resolveRipgrep()
  if (!bin) return { kind: "failed", reason: "ripgrep not available" }
  const baseArgs = buildSearchArgs(query)

  let run = await runRipgrep(bin, baseArgs, { cwd: query.cwd, timeoutMs: DEFAULT_TIMEOUT_MS, signal: opts.signal })
  // The Rust regex engine rejects JS-flavored look-around; PCRE2 (when
  // the binary supports it) accepts it. One bounded retry, then fall back.
  if (run.exitCode === 2 && /look-around|not supported|regex parse error/i.test(run.stderr)) {
    run = await runRipgrep(bin, ["--pcre2", ...baseArgs], {
      cwd: query.cwd,
      timeoutMs: PCRE2_RETRY_TIMEOUT_MS,
      signal: opts.signal,
    })
  }

  if (run.spawnError) return { kind: "failed", reason: `spawn failed: ${run.spawnError}` }
  if (run.timedOut) return { kind: "failed", reason: "ripgrep timed out" }
  if (run.exitCode === 2) {
    const firstLine = run.stderr.split(/\r?\n/).find((l) => l.trim().length > 0)
    return { kind: "failed", reason: firstLine?.trim() ?? "ripgrep rejected the pattern" }
  }
  if (run.exitCode === null && !run.bytesTruncated) {
    return { kind: "failed", reason: "ripgrep exited without a status" }
  }
  // filesOnly mode emits plain paths (one per line), not JSON events.
  const hits = query.filesOnly
    ? run.stdout
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((raw) => ({
          path: normalizeRgPath(raw),
          line: 0,
          text: "",
          isMatch: true,
        }))
    : parseRgJson(run.stdout)
  return { kind: "ok", hits, truncated: run.bytesTruncated }
}

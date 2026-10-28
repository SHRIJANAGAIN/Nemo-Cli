/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The `diagnostics` tool — LSP-lite's project-wide layer. Spawns
 * `tsc --noEmit --pretty false` in a child process (never blocks the TUI's
 * event loop), parses the output into per-file diagnostics, and renders Shrijan's
 * `<diagnostics>` report blocks for the model. Results are cached for a few
 * seconds so repeated agent calls don't re-run the compiler; `refresh`
 * bypasses the cache.
 */

import { spawn } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"
import { textResult, type Tool } from "../types.js"
import {
  DIAGNOSTICS_MAX_PER_FILE,
  findUp,
  parseTscOutput,
  pickFiles,
  report,
  type Diagnostic,
} from "./tsc-diagnostics.js"

/**
 * Cold budget for one tsc pass. A full monorepo check is tens of seconds,
 * and a budget below that turned the tool into a no-op that reported
 * "Diagnostics unavailable" while the compiler was still working.
 */
const TSC_TIMEOUT_MS = 90_000
export { TSC_TIMEOUT_MS }
const CACHE_TTL_MS = 10_000
const MAX_TSC_OUTPUT_BYTES = 20 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024

export interface DiagnosticsSnapshot {
  tsconfigPath: string
  projectRoot: string
  diagnostics: Record<string, Diagnostic[]>
  unlocated: string[]
  generatedAt: number
  /** How long the tsc pass took — a cold check is slow, and saying so
   *  stops "no errors" from reading as "nothing happened". */
  durationMs: number
}

export type CollectResult = { ok: true; snapshot: DiagnosticsSnapshot } | { ok: false; reason: string }

interface TscRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

let cache: { tsconfigPath: string; at: number; snapshot: DiagnosticsSnapshot } | undefined

/** Tests: drop the inter-run cache. */
export function resetDiagnosticsCache(): void {
  cache = undefined
}

/**
 * Per-project incremental state for tsc.
 *
 * Without it every call re-checks the whole program from scratch (tens of
 * seconds on a monorepo); with it the second call only re-checks what
 * changed. The file lives in nemo's own cache dir — never in the project,
 * which the tool has no business writing to.
 */
function prepareBuildInfo(tsconfigPath: string): string | undefined {
  try {
    const hash = createHash("sha1").update(path.resolve(tsconfigPath)).digest("hex").slice(0, 16)
    const dir = path.join(os.homedir(), ".nemo", "cache", "diagnostics")
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, `${hash}.tsbuildinfo`)
  } catch {
    // No writable cache dir: a plain (slower) run still beats no run.
    return undefined
  }
}

/** Locate `node_modules/typescript/bin/tsc`: walk up from cwd first (the
 * project's own TypeScript), then fall back to nemo's bundled copy (its
 * build depends on tsc, so any working install has one). */
export function resolveTscBin(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (;;) {
    const candidate = path.join(dir, "node_modules", "typescript", "bin", "tsc")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    if (typeof __dirname !== "undefined") {
      // dist/apps/runtime/src/tools/diagnostics and apps/runtime/src/tools/...
      // are the same depth below the repo root.
      const bundled = path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "node_modules",
        "typescript",
        "bin",
        "tsc",
      )
      if (fs.existsSync(bundled)) return bundled
    }
  } catch {
    /* no bundled fallback available */
  }
  return undefined
}

function runTsc(bin: string, projectRoot: string, tsconfigPath: string, signal?: AbortSignal): Promise<TscRun> {
  return new Promise<TscRun>((resolve) => {
    const startedAt = Date.now()
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true, durationMs: 0 })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      // `bin` resolves from the PROJECT's own node_modules first (see
      // resolveTscBin), so a planted or compromised `typescript` package
      // runs here as code we did not write — it must never see API keys.
      // Same boundary as hook/MCP/git/monitor children: getSafeEnv strips
      // credential-shaped names, PATH/HOME survive. (#112)
      const args = [bin, "--noEmit", "--pretty", "false"]
      const buildInfo = prepareBuildInfo(tsconfigPath)
      if (buildInfo) args.push("--incremental", "--tsBuildInfoFile", buildInfo)
      args.push("-p", tsconfigPath)
      child = spawn(process.execPath, args, {
        cwd: projectRoot,
        env: getSafeEnv(process.env),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error), timedOut: false, aborted: false, durationMs: 0 })
      return
    }
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (run: Omit<TscRun, "durationMs">): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({ ...run, durationMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, timedOut: true, aborted: false })
    }, TSC_TIMEOUT_MS)
    const onAbort = (): void => {
      child.kill()
      finish({ code: null, stdout, stderr, timedOut: false, aborted: true })
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_TSC_OUTPUT_BYTES) stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false, aborted: false })
    })
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false, aborted: false })
    })
  })
}

/** Find the project's tsconfig, run (or reuse) a tsc pass, and return the
 * parsed per-file snapshot. */
export async function collectDiagnostics(cwd: string, refresh = false, signal?: AbortSignal): Promise<CollectResult> {
  const tsconfigPath = findUp("tsconfig.json", cwd)
  if (!tsconfigPath) {
    return { ok: false, reason: `no tsconfig.json found from ${cwd} — diagnostics require a TypeScript project` }
  }
  const projectRoot = path.dirname(tsconfigPath)
  if (!refresh && cache && cache.tsconfigPath === tsconfigPath && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, snapshot: cache.snapshot }
  }
  const bin = resolveTscBin(cwd)
  if (!bin) {
    return { ok: false, reason: "typescript is not installed (no node_modules/typescript) — cannot run tsc" }
  }
  const run = await runTsc(bin, projectRoot, tsconfigPath, signal)
  if (run.aborted) return { ok: false, reason: "aborted" }
  if (run.timedOut) return { ok: false, reason: `tsc timed out after ${Math.round(TSC_TIMEOUT_MS / 1000)}s` }
  if (run.code === null && !run.stdout) {
    return { ok: false, reason: `tsc failed to start: ${run.stderr.trim() || "unknown error"}` }
  }
  const { diagnostics, unlocated } = parseTscOutput(run.stdout, projectRoot)
  const snapshot: DiagnosticsSnapshot = {
    tsconfigPath,
    projectRoot,
    diagnostics,
    unlocated,
    generatedAt: Date.now(),
    durationMs: run.durationMs,
  }
  cache = { tsconfigPath, at: snapshot.generatedAt, snapshot }
  return { ok: true, snapshot }
}

const definition: ToolDefinition = {
  // Must outlast TSC_TIMEOUT_MS so the tool's own "tsc timed out" message
  // fires instead of the harness killing the call (see the timing-contract
  // test).
  timeoutMs: 120_000,
  name: "diagnostics",
  description:
    "Run the TypeScript compiler (tsc --noEmit) and report diagnostics (errors/warnings) per file. Use after making code changes to verify they compile; optionally filter to specific files. The first run type-checks the whole project and can take a minute; later runs reuse the incremental state and are far quicker.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      files: {
        type: "array",
        items: { type: "string", description: "Path to a file (relative or absolute)." },
        description: "Only report these files (relative or absolute paths). Default: whole project.",
      },
      refresh: { type: "boolean", description: "Force a fresh tsc run instead of reusing the recent cache." },
    },
  },
}

export function createDiagnosticsTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      const cwd = context?.cwd ?? process.cwd()
      const filters = Array.isArray(args.files) ? args.files.map(String) : []
      const refresh = Boolean(args.refresh)
      const result = await collectDiagnostics(cwd, refresh, signal)
      if (!result.ok) return textResult(`Diagnostics unavailable: ${result.reason}.`)
      const picked = pickFiles(result.snapshot.diagnostics, filters, cwd)
      const entries = Object.entries(picked).sort(([a], [b]) => a.localeCompare(b))
      let errors = 0
      let warnings = 0
      const blocks: string[] = []
      for (const [file, items] of entries) {
        for (const item of items) {
          if (item.severity === 1) errors += 1
          else if (item.severity === 2) warnings += 1
        }
        const block = report(file, items)
        if (block) blocks.push(block)
      }
      const filterNote = filters.length > 0 ? ` (filtered to ${filters.length} path(s))` : ""
      const globalNote =
        filters.length === 0 && result.snapshot.unlocated.length > 0
          ? `, ${result.snapshot.unlocated.length} project-level message(s)`
          : ""
      const took = (result.snapshot.durationMs / 1000).toFixed(1)
      const summary = `Diagnostics: ${errors} error(s), ${warnings} warning(s) across ${entries.length} file(s)${globalNote}${filterNote}. Checked in ${took}s.`
      const parts = [summary]
      if (blocks.length > 0) parts.push("", blocks.join("\n\n"))
      if (filters.length === 0 && result.snapshot.unlocated.length > 0) {
        parts.push("", "Project-level:", ...result.snapshot.unlocated.slice(0, DIAGNOSTICS_MAX_PER_FILE))
      }
      if (filters.length > 0 && entries.length === 0 && result.snapshot.unlocated.length === 0) {
        parts.push("", `No diagnostics for: ${filters.join(", ")}`)
      }
      return textResult(parts.join("\n"))
    },
  }
}

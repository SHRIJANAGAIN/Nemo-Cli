/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition, ToolResult } from "../../../../packages/protocol/src/index.js"
import type { TrayambakConfig } from "../config.js"
import type { PermissionConfig } from "../../../../packages/protocol/src/permissions.js"
import type { Provider } from "../../../../packages/provider/src/index.js"

export type { ToolResult, ToolDefinition } from "../../../../packages/protocol/src/index.js"

const TRUNCATION_DIR = path.join(os.homedir(), ".trayambak", "storage", "truncation")
const TRUNCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface ToolContext {
  cwd: string
  config: TrayambakConfig
  permissions: PermissionConfig
  sessionId?: string
  requestPermission?: (tool: string, command: string, reason: string) => Promise<boolean>
  /** Live model provider for tools that generate (sota_solve). Absent in
   *  offline/test contexts — tools must fall back gracefully. */
  provider?: Provider
}

export interface Tool {
  definition: ToolDefinition
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate?: (partial: ToolResult) => void,
    context?: ToolContext,
  ): Promise<ToolResult>
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError }
}

export interface TruncationResult {
  text: string
  truncated: boolean
  outputPath?: string
}

/**
 * Truncate output to fit within limits. If the text exceeds limits, the full
 * content is written to a file in the truncation directory (7-day retention)
 * and a preview with a reference to the file is returned — mirroring SKT AI LABS's
 * truncate.ts behavior.
 */
export function truncateOutput(
  text: string,
  config: TrayambakConfig,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult {
  const maxLines = options?.maxLines ?? config.maxOutputLines
  const maxBytes = options?.maxBytes ?? config.maxOutputBytes

  const lines = text.split("\n")
  const byteSize = Buffer.byteLength(text, "utf8")

  if (lines.length <= maxLines && byteSize <= maxBytes) {
    return { text, truncated: false }
  }

  // If the text fits within byte limit but has too many lines, truncate lines
  if (byteSize <= maxBytes) {
    const truncatedLines = lines.slice(-maxLines)
    const note = `\n[output truncated: showing last ${truncatedLines.length} lines of ${lines.length}]`
    return { text: truncatedLines.join("\n") + note, truncated: true }
  }

  // Both limits exceeded — write to file and return preview
  const preview = lines.slice(-Math.max(1, Math.floor(maxLines / 2)))
  let previewText = preview.join("\n")
  if (Buffer.byteLength(previewText, "utf8") > maxBytes) {
    previewText = previewText.slice(previewText.length - maxBytes)
  }

  let outputPath: string | undefined
  try {
    if (!fs.existsSync(TRUNCATION_DIR)) {
      fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
    }
    const fileName = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.txt`
    outputPath = path.join(TRUNCATION_DIR, fileName)
    fs.writeFileSync(outputPath, text, "utf8")
    cleanupOldTruncationFiles()
  } catch {
    /* If we can't write to the truncation dir, fall back to preview only */
  }

  const note = outputPath
    ? `\n\n[output truncated: showing last ${preview.length} lines of ${lines.length}. Full output written to ${outputPath}]`
    : `\n\n[output truncated: showing last ${preview.length} lines of ${lines.length}]`

  return { text: previewText + note, truncated: true, outputPath }
}

/** Remove truncation files older than 7 days (SKT AI LABS truncate.ts pattern). */
function cleanupOldTruncationFiles(): void {
  try {
    if (!fs.existsSync(TRUNCATION_DIR)) return
    const cutoff = Date.now() - TRUNCATION_RETENTION_MS
    for (const entry of fs.readdirSync(TRUNCATION_DIR)) {
      const filePath = path.join(TRUNCATION_DIR, entry)
      const info = fs.statSync(filePath)
      if (info.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}

export { TRUNCATION_DIR }

/**
 * Workspace metadata that file tools may read but never write (create,
 * modify, or delete). `.git` is the repository's trust anchor — `git/hooks`
 * executes arbitrary code on commit — and `.trayambak` holds the agent's own
 * state (sessions, commands, plans, credentials). Ported from Codex's
 * protected metadata (`.git` / `.codex` / `.agents`), with one deliberate
 * hardening: the segment must match *anywhere* in the path, not only as the
 * top-level first component under a writable root, so nested repositories
 * (`vendor/lib/.git`) are covered too. Matching is case-insensitive so
 * `.GIT` cannot slip past on a case-sensitive host; `.github/`, `.gitkeep`
 * and `sub/.gitignore` are segment-distinct and stay writable.
 */
const PROTECTED_METADATA_DIRS = [".git", ".trayambak"]

/**
 * Write-side gate: throws for paths the file tools may never mutate.
 * Runs before the approval prompt — a doomed path must not consume a
 * permission question (Codex checks patch safety the same way).
 */
export function assertMutablePath(filepath: string): void {
  const parts = filepath.split(/[\\/]/)
  const file = parts.at(-1)
  const dir = parts.at(-2)
  // Legacy state dirs from pre-rebrand installs: their agent-manager.json
  // must stay tool-protected (`.trayambak` is covered by
  // PROTECTED_METADATA_DIRS below with the generic message).
  if (file === "agent-manager.json" && [".kilo", ".SKT AI LABS"].includes(dir ?? "")) {
    throw new Error("Do not edit Agent Manager state directly. Use the agent_manager tool.")
  }
  const folded = parts.map((seg) => seg.toLowerCase())
  if (folded.some((seg) => PROTECTED_METADATA_DIRS.includes(seg))) {
    throw new Error(`protected metadata: ${filepath} (.git and .trayambak are read-only to tools)`)
  }
}

export function assertExternalDirectory(target: string, cwd: string): void {
  if (!target) return
  const within = (base: string, target: string): boolean => {
    const normBase = path.normalize(base).toLowerCase()
    const normTarget = path.normalize(target).toLowerCase()
    if (normTarget === normBase) return true
    const sep = path.sep
    if (!normBase.endsWith(sep)) {
      return normTarget === normBase || normTarget.startsWith(normBase + sep)
    }
    return normTarget.startsWith(normBase)
  }
  const home = os.homedir()
  if (within(cwd, target) || within(home, target)) return
  throw new Error(`Access denied: target is outside workspace (${target})`)
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2))
  return p
}

/** True when `target` is `base` itself or a descendant of it. */
function within(base: string, target: string): boolean {
  const normBase = path.normalize(base).toLowerCase()
  const normTarget = path.normalize(target).toLowerCase()
  if (normTarget === normBase) return true
  const baseWithSep = normBase.endsWith(path.sep) ? normBase : normBase + path.sep
  return normTarget.startsWith(baseWithSep)
}

/**
 * Credential stores under the home directory. `~` is reachable by design so
 * tooling can touch `~/projects`, so without this list
 * `read-file("~/.ssh/id_rsa")` would succeed. Matching is case-insensitive so
 * `~/.SSH` cannot slip past on a case-sensitive host.
 */
const PROTECTED_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure"]

/** Single files under home that hold credentials. */
const PROTECTED_HOME_FILES = [".netrc", ".npmrc", ".git-credentials", path.join(".trayambak", "credentials.json")]

/**
 * True for paths the file tools may never open. Deny wins over the `~`
 * allowance: sandbox policy never lets a deny rule be outvoted by an allow.
 */
function isProtectedPath(resolved: string, home: string = os.homedir()): boolean {
  for (const dir of PROTECTED_HOME_DIRS) {
    if (within(path.join(home, dir), resolved)) return true
  }
  const folded = resolved.toLowerCase()
  for (const file of PROTECTED_HOME_FILES) {
    if (folded === path.join(home, file).toLowerCase()) return true
  }
  return false
}

/**
 * Resolve a user-supplied path against the tool cwd and reject it if it
 * escapes the project directory (or the user home directory for `~` paths).
 * This blocks absolute paths and `..` escapes that would otherwise allow
 * reading/writing arbitrary files on disk.
 *
 * The workspace is not a blanket override: credential stores stay closed even
 * when the project is opened at home, because deny lists win over allow lists.
 */
/**
 * Resolve as much of `p` as actually exists to its real on-disk location, then
 * re-attach the not-yet-created remainder.
 *
 * Containment checks that compare path STRINGS are blind to directory
 * junctions and symlinks: `<proj>/link/secret.txt` passes every lexical test
 * while the bytes come from somewhere else entirely (a junction needs no
 * extra privilege on Windows and resolves for any local process). Walking up
 * to the nearest existing ancestor keeps this correct for paths that do not
 * exist yet, which is the normal case for a write.
 *
 * Deliberately total: if nothing along the chain resolves it returns the
 * input unchanged rather than throwing, so the caller's own containment
 * decision still stands (this function only ever supplies a real anchor).
 */
function realpathNearest(p: string): string {
  let current = path.resolve(p)
  const tail: string[] = []
  // Each iteration strips one path segment, so this always terminates: the
  // walk bottoms out at the filesystem root, where dirname(root) === root.
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length === 0 ? real : path.join(real, ...tail)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return p
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a user-supplied path against the tool cwd and reject it if it
 * escapes the project directory (or the user home directory for `~` paths).
 * This blocks absolute paths and `..` escapes that would otherwise allow
 * reading/writing arbitrary files on disk.
 *
 * The workspace is not a blanket override: credential stores stay closed even
 * when the project is opened at home, because deny lists win over allow lists.
 *
 * Containment is checked TWICE: once lexically, then again with both sides
 * resolved through `realpathNearest`. The second pass is what stops a junction
 * planted inside an allowed root from reading or writing outside it. Both
 * checks must pass, so a link can only ever narrow what is reachable.
 */
export function resolveConstrainedPath(inputPath: string, cwd: string): string {
  const expanded = expandHome(inputPath)
  const resolved = path.resolve(cwd, expanded)
  const home = os.homedir()
  if (!within(cwd, resolved) && !within(home, resolved)) {
    throw new Error(`Access denied: path escapes project directory (${resolved})`)
  }
  if (isProtectedPath(resolved)) {
    throw new Error(`Access denied: protected path (${resolved})`)
  }

  // Reparse-point layer. The roots are resolved the same way as the target so
  // a workspace that itself lives under a link (a temp dir, a redirected home)
  // still compares equal to itself.
  const realHome = realpathNearest(home)
  const realCwd = realpathNearest(cwd)
  const realResolved = realpathNearest(resolved)
  if (!within(realCwd, realResolved) && !within(realHome, realResolved)) {
    throw new Error(`Access denied: path escapes project directory through a link (${resolved} -> ${realResolved})`)
  }
  // A link is not a way around the credential deny list either.
  if (isProtectedPath(realResolved, realHome)) {
    throw new Error(`Access denied: protected path through a link (${resolved} -> ${realResolved})`)
  }
  return resolved
}

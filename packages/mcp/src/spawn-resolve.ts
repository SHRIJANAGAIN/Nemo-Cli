/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Spawn-command resolution for MCP stdio servers.
 *
 * Bare `spawn("npx", …)` fails with ENOENT when the parent was launched
 * from a GUI (limited PATH), and spawning `*.cmd` shims directly throws
 * EINVAL (shell:false) or mangles paths (shell:true). Every stdio spawn
 * site must route argv through `resolveMcpCommand()` first:
 * `npx` → `node npx-cli.js`, `node` → current binary, `python*`/`uvx` →
 * absolute resolved path. Anything else passes through untouched so the
 * existing stderr-tail diagnostics still surface real failures.
 */

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Rank a `where.exe` hit for spawnability (lower is better). Windows cannot
 * spawn extensionless POSIX shell scripts directly — only PATHEXT entries.
 */
function scoreExecutable(file: string): number {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".exe" || ext === ".com") return 0
  if (ext === ".bat" || ext === ".cmd") return 1
  if (ext !== "") return 2
  return 3
}

/**
 * Windows can only directly spawn `.exe`/`.com`: `*.cmd`/`*.bat` are batch
 * scripts (Node throws `spawn EINVAL` since DEP0190 — CVE-2024-27980) and
 * extensionless POSIX shims fail with `spawn ENOENT` (no shebang handling).
 * POSIX passes through — the kernel honors shebangs there.
 */
export function canSpawnDirectly(bin: string): boolean {
  if (process.platform !== "win32") return true
  const ext = path.extname(bin).toLowerCase()
  return ext === ".exe" || ext === ".com"
}

/**
 * Resolve a binary name to an absolute spawnable path (PATH lookup, the
 * node install dir, well-known locations). Undefined when not found.
 */
export function resolveExecutable(name: string): string | undefined {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where.exe", [name], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
      const ranked = String(out)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .sort((a, b) => scoreExecutable(a) - scoreExecutable(b))
      for (const line of ranked) {
        try {
          if (fs.existsSync(line)) return line
        } catch {
          /* keep looking */
        }
      }
    } catch {
      /* fall through to well-known locations */
    }
  } else {
    try {
      const out = execFileSync(`command -v ${name}`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: "/bin/sh",
        stdio: ["ignore", "pipe", "ignore"],
      })
      const first = String(out).trim().split(/\s+/)[0]
      if (first && fs.existsSync(first)) return first
    } catch {
      /* fall through to well-known locations */
    }
  }

  const candidates: string[] = []
  try {
    const nodeDir = path.dirname(process.execPath)
    for (const ext of process.platform === "win32" ? [".cmd", ".exe", ""] : [""]) {
      candidates.push(path.join(nodeDir, `${name}${ext}`))
    }
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files"
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
    candidates.push(
      path.join(programFiles, "nodejs", `${name}.cmd`),
      path.join(programFilesX86, "nodejs", `${name}.cmd`),
      path.join(os.homedir(), "AppData", "Roaming", "npm", `${name}.cmd`),
    )
  } else {
    candidates.push(`/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`, `${os.homedir()}/.local/bin/${name}`)
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      if (process.platform === "win32" && scoreExecutable(candidate) > 1) continue
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

function npmDirCandidates(): string[] {
  const dirs: string[] = []
  try {
    dirs.push(path.dirname(process.execPath))
  } catch {
    /* ignore */
  }
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files"
  dirs.push(path.join(programFiles, "nodejs"))
  // Global-prefix layouts (npm's own prefix) keep the shims AND their
  // node_modules/npm payload beside the resolved binary, not beside node —
  // cover the directories where `npm`/`npx` actually resolve too.
  for (const name of ["npm", "npx"]) {
    try {
      const bin = resolveExecutable(name)
      if (bin) dirs.push(path.dirname(bin))
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== "win32") {
    dirs.push("/usr/local/lib/node_modules/npm", "/opt/homebrew/lib/node_modules/npm", "/usr/lib/node_modules/npm")
  }
  return [...new Set(dirs)]
}

/** Locate npm's JS entry so npm runs as `node npm-cli.js …` (no shell/shim). */
export function resolveNpmCliJs(): string | undefined {
  for (const dir of npmDirCandidates()) {
    const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
    try {
      if (fs.existsSync(cli)) return cli
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Locate npx's JS entry so npx runs as `node npx-cli.js …`. */
export function resolveNpxCliJs(): string | undefined {
  for (const dir of npmDirCandidates()) {
    const cli = path.join(dir, "node_modules", "npm", "bin", "npx-cli.js")
    try {
      if (fs.existsSync(cli)) return cli
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

export interface ResolvedCommand {
  command: string
  args: string[]
}

/**
 * Rewrite an MCP server argv into something `spawn(..., { shell: false })`
 * can actually launch. Throws a human-readable error when the runtime the
 * spec needs is not installed (instead of a bare `spawn X ENOENT`).
 */
export function resolveMcpCommand(argv: string[]): ResolvedCommand {
  const [raw, ...rest] = argv
  if (!raw) throw new Error("MCP server spec has an empty command")
  const base = path
    .basename(raw)
    .replace(/\.(cmd|exe|bat|com)$/i, "")
    .toLowerCase()

  if (base === "node") {
    return { command: process.execPath, args: rest }
  }

  if (base === "npx") {
    const cli = resolveNpxCliJs()
    if (cli) return { command: process.execPath, args: [cli, ...rest] }
    const bin = resolveExecutable("npx")
    if (bin && canSpawnDirectly(bin)) return { command: bin, args: rest }
    throw new Error(
      "npx was not found. Install Node.js (https://nodejs.org) or run from a terminal where `npx --version` works, then retry.",
    )
  }

  if (base === "npm") {
    // Same shim story as npx: prefer `node npm-cli.js`; a bare *.cmd would
    // throw EINVAL under shell:false (see canSpawnDirectly).
    const cli = resolveNpmCliJs()
    if (cli) return { command: process.execPath, args: [cli, ...rest] }
    const bin = resolveExecutable("npm")
    if (bin && canSpawnDirectly(bin)) return { command: bin, args: rest }
    throw new Error(
      bin
        ? `npm resolves only to the Windows shim ${bin}, which cannot be spawned without a shell. Reinstall Node.js (https://nodejs.org) so node_modules/npm is present, then retry.`
        : "npm was not found. Install Node.js (https://nodejs.org) or run from a terminal where `npm --version` works, then retry.",
    )
  }

  if (base === "uvx") {
    const bin = resolveExecutable("uvx")
    if (bin) return { command: bin, args: rest }
    throw new Error(
      "uvx was not found. Install uv (https://docs.astral.sh/uv/) or run from a terminal where `uvx --version` works, then retry.",
    )
  }

  if (base === "python" || base === "python3" || base === "py") {
    const bin = resolveExecutable(base) ?? resolveExecutable("python3") ?? resolveExecutable("python")
    if (bin) return { command: bin, args: rest }
    throw new Error(
      "python was not found. Install Python (https://www.python.org) or run from a terminal where `python --version` works, then retry.",
    )
  }

  if (path.isAbsolute(raw)) return { command: raw, args: rest }
  const resolved = resolveExecutable(base)
  if (resolved) {
    if (canSpawnDirectly(resolved)) return { command: resolved, args: rest }
    // A resolved *.cmd would die as a bare `spawn EINVAL` at launch time —
    // fail here with the reason instead of an opaque harness error.
    throw new Error(
      `'${base}' resolves only to the Windows shim ${resolved}, which cannot be spawned without a shell. Use a node script (node <entry.js>) or a native executable instead.`,
    )
  }
  // Unknown bare command: pass through so existing diagnostics (stderr
  // tail, exit code) describe the real failure instead of a guess.
  return { command: raw, args: rest }
}

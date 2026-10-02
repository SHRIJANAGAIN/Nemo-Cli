/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { getConnectorRegistry, type ConnectorEntry } from "./registry.js"
import { saveConfig, type TrayambakConfig } from "../../../src/config.js"
import { canSpawnDirectly, resolveExecutable, resolveNpmCliJs } from "../../../../../packages/mcp/src/spawn-resolve.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"

// Re-exported so existing importers (tests, CLI) keep working — the
// implementation lives in packages/mcp (one copy, no drift).
export { canSpawnDirectly, resolveExecutable, resolveNpmCliJs } from "../../../../../packages/mcp/src/spawn-resolve.js"

/** Install root resolved per call (the old module-level constant froze
 *  process.cwd() at import, scattering installs across daemon/TUI cwds). */
function installDirFor(serverId: string, cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".trayambak", "mcp-installs", serverId)
}

export interface InstallResult {
  server: string
  status: "installed" | "already_installed" | "failed" | "skipped"
  message: string
}

export function listAvailableMcpServers(): ConnectorEntry[] {
  return getConnectorRegistry().load()
}

export function searchMcpServers(query: string): ConnectorEntry[] {
  return getConnectorRegistry().search(query)
}

export async function installMcpServer(
  serverId: string,
  cwd?: string,
  config?: TrayambakConfig,
): Promise<InstallResult> {
  const registry = getConnectorRegistry()
  const entry = registry.get(serverId)
  if (!entry) {
    return {
      server: serverId,
      status: "failed",
      message: `MCP server '${serverId}' not found in registry. Use /mcp search to find available servers.`,
    }
  }

  const spec = entry.spec
  const command: string[] = Array.isArray(spec.command) ? spec.command : []
  const prog = command[0]
  const args = command.slice(1)

  const persist = (result: InstallResult, runnableSpec?: ConnectorEntry["spec"]): InstallResult => {
    if (result.status !== "installed" || !config) return result
    try {
      const current = { ...(config.mcpServers ?? {}) }
      // Persist what actually RUNS (local install dir / runnable command),
      // not the raw registry template — the old code saved the template, so
      // the installed payload was never referenced at runtime.
      current[serverId] = runnableSpec ?? spec
      saveConfig({ mcpServers: current } as Partial<TrayambakConfig>)
      return { ...result, message: `${result.message}\nMCP server '${serverId}' saved to trayambak config.` }
    } catch {
      return result
    }
  }

  if (entry.npmPackage && command[0] === "npx") {
    // Prefer node + npm-cli.js: spawning npm.cmd directly throws EINVAL
    // (shell:false) or mangles quoted paths (shell:true, DEP0190).
    const npmCliJs = resolveNpmCliJs()
    // Fallback only when the entry point resolves AND the binary is
    // directly spawnable — a bare *.cmd dies as `spawn EINVAL` under
    // shell:false, so a shim-only npm counts as not runnable.
    const npmBinRaw = npmCliJs ? undefined : resolveExecutable("npm")
    const npmBin = npmBinRaw && canSpawnDirectly(npmBinRaw) ? npmBinRaw : undefined
    if (!npmCliJs && !npmBin) {
      const located = resolveExecutable("npm")
      return {
        server: serverId,
        status: "failed",
        message: located
          ? `npm was found at ${located} but cannot be launched without a shell (only a Windows .cmd shim was resolved). Reinstall Node.js (https://nodejs.org) so node_modules/npm is present, then retry.`
          : "npm was not found on PATH. Install Node.js (https://nodejs.org) or run from a terminal where `npm --version` works, then retry.",
      }
    }
    try {
      const installDir = installDirFor(serverId, cwd)
      fs.mkdirSync(installDir, { recursive: true })
      const bin = npmCliJs ? process.execPath : (npmBin as string)
      const binArgs = npmCliJs
        ? [npmCliJs, "install", "--prefix", installDir, entry.npmPackage]
        : ["install", "--prefix", installDir, entry.npmPackage]
      await execAsync(bin, binArgs, cwd || installDir)
      // Prefer the just-installed payload over a fresh npx download: resolve
      // <pkg>/dist/index.js when present, else keep the npx command.
      const runnable = resolveInstalledEntry(installDir, entry.npmPackage) ?? { command }
      return persist(
        { server: serverId, status: "installed", message: `Installed ${entry.npmPackage} to ${installDir}` },
        runnable,
      )
    } catch (err) {
      return {
        server: serverId,
        status: "failed",
        message: `npm install failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (entry.npmPackage === "mcp" || prog === "python" || prog === "python3") {
    try {
      const installDir = installDirFor(serverId, cwd)
      fs.mkdirSync(installDir, { recursive: true })
      const scriptRel = args.find((a) => typeof a === "string" && a.endsWith(".py"))
      if (scriptRel) {
        const scriptAbs = path.isAbsolute(scriptRel) ? scriptRel : path.resolve(spec.cwd || cwd || ".", scriptRel)
        if (!fs.existsSync(scriptAbs)) {
          return { server: serverId, status: "failed", message: `Server script not found: ${scriptAbs}` }
        }
        const pipBin =
          resolveExecutable("pip") ??
          resolveExecutable("pip3") ??
          resolveExecutable("python") ??
          resolveExecutable("python3")
        if (!pipBin) {
          return {
            server: serverId,
            status: "failed",
            message:
              "Neither pip nor python was found on PATH. Install Python (https://www.python.org) or run from a terminal where `pip --version` works, then retry.",
          }
        }
        if (/pip3?$/.test(path.basename(pipBin, path.extname(pipBin)))) {
          await execAsync(pipBin, ["install", "mcp"], cwd || installDir)
        } else {
          await execAsync(pipBin, ["-m", "pip", "install", "mcp"], cwd || installDir)
        }
        return persist(
          { server: serverId, status: "installed", message: `Python MCP server ready at ${scriptAbs}` },
          { command: [prog, scriptAbs], cwd: path.dirname(scriptAbs) },
        )
      }
      return { server: serverId, status: "skipped", message: "No Python script path found in server spec." }
    } catch (err) {
      return {
        server: serverId,
        status: "failed",
        message: `Python setup failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return {
    server: serverId,
    status: "skipped",
    message: `Unknown server type for '${serverId}'. Configure manually in trayambak config.`,
  }
}

/** Locate a runnable entry inside an `npm --prefix` payload. */
export function resolveInstalledEntry(installDir: string, npmPackage: string): ConnectorEntry["spec"] | undefined {
  const base = path.join(installDir, "node_modules", npmPackage)
  for (const rel of ["dist/index.js", "dist/index.cjs", "index.js", "lib/index.js"]) {
    const abs = path.join(base, rel)
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { command: ["node", abs] }
      }
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

export function createMcpInstallTool(): Tool {
  const definition: ToolDefinition = {
    // Install is a real `npm install` of a package tree — 30s killed it
    // mid-download (the "sometimes just exits" symptom). The internal
    // execAsync deadline is 180s; the harness bound must outlast it, so a
    // failure surfaces as npm's own exit code/stderr, never as a kill.
    timeoutMs: 300_000,
    name: "mcp__install",
    description:
      "Install and manage MCP (Model Context Protocol) servers. Use /mcp search to find servers, /mcp install <id> to install, /mcp list to see available.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["search", "install", "list", "info"],
          description:
            "Action: search (find servers), install (install a server), list (all available), info (details for one server).",
        },
        query: {
          type: "string",
          description: "Search query for search action, or server ID for info/install.",
        },
      },
    },
  }

  return {
    definition,
    async execute(_id, args, _signal, _update, context: ToolContext | undefined) {
      const action = (args.action as string) ?? "list"
      const query = (args.query as string) ?? ""

      if (action === "list") {
        const all = listAvailableMcpServers()
        const lines = all.map((c) => `  ${c.id}: ${c.description} [${c.category}]`)
        return textResult(`Available MCP servers (${all.length}):\n${lines.join("\n")}`)
      }

      if (action === "search") {
        const results = searchMcpServers(query || "mcp")
        if (results.length === 0) return textResult(`No MCP servers found for '${query}'.`)
        const lines = results.map((c) => `  ${c.id}: ${c.description} [${c.category}]`)
        return textResult(`Found ${results.length} MCP servers:\n${lines.join("\n")}`)
      }

      if (action === "info") {
        const entry = getConnectorRegistry().get(query)
        if (!entry)
          return textResult(`MCP server '${query}' not found. Use /mcp search to find servers.`, /*isError*/ true)
        const lines = [
          `ID: ${entry.id}`,
          `Name: ${entry.name}`,
          `Description: ${entry.description}`,
          `Category: ${entry.category}`,
          `Keywords: ${(entry.keywords ?? []).join(", ")}`,
          `Spec: ${JSON.stringify(entry.spec, null, 2)}`,
          entry.npmPackage ? `NPM Package: ${entry.npmPackage}` : "",
        ].filter(Boolean)
        return textResult(lines.join("\n"))
      }

      if (action === "install") {
        const result = await installMcpServer(query, context?.cwd, context?.config)
        if (result.status === "failed") return textResult(result.message, /*isError*/ true)
        return textResult(result.message)
      }

      return textResult(`Unknown action: ${action}. Use search, install, list, or info.`, /*isError*/ true)
    },
  }
}

/** Exported for tests: exit codes and spawn failures must surface as
 *  rejections carrying the real code/stderr (never a silent success). */
export function execAsync(command: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Installers run arbitrary package code (postinstall scripts), so they
      // get the same filtered env as bash — never the raw secret-bearing
      // process.env (#75). PATH/HOME stay intact: npm and pip keep working
      // (file-based .npmrc/pip.conf auth is unaffected).
      env: getSafeEnv(process.env),
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`))
    }, timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    child.stdout.on("data", (c: Buffer | string) => {
      stdout += c.toString()
    })
    child.stderr.on("data", (c: Buffer | string) => {
      stderr += c.toString()
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Command failed (${code}): ${(stderr || stdout).slice(-2000)}`))
    })
    child.on("error", (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

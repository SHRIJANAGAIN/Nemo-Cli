/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { getConnectorRegistry, type ConnectorEntry } from "./registry.js"
import { saveConfig, type TrayambakConfig } from "../../../src/config.js"

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
    try {
      const installDir = installDirFor(serverId, cwd)
      fs.mkdirSync(installDir, { recursive: true })
      await execAsync("npm", ["install", "--prefix", installDir, entry.npmPackage], cwd || installDir)
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
        await execAsync("pip", ["install", "mcp"], cwd || installDir)
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
        if (!entry) return textResult(`MCP server '${query}' not found. Use /mcp search to find servers.`, true)
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
        if (result.status === "failed") return textResult(result.message, true)
        return textResult(result.message)
      }

      return textResult(`Unknown action: ${action}. Use search, install, list, or info.`, true)
    },
  }
}

function execAsync(command: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
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

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * MCP server over stdio (JSON-RPC 2.0): exposes Trayambak tools to MCP clients.
 * Methods: initialize, tools/list, tools/call, resources/list, prompts/list.
 * Run: `trayambak mcp-server`
 */

import * as readline from "readline"
import * as fs from "fs"
import { execFileSync } from "child_process"

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: McpToolDef[] = [
  {
    name: "bash",
    description: "Execute a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "write_file",
    description: "Write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  },
  {
    name: "grep",
    description: "Search file contents",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  },
  {
    name: "glob",
    description: "Find files by glob",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  },
]

function send(id: unknown, result: unknown): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function sendError(id: unknown, code: number, message: string): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
}

/** Real local execution for read-only tools. bash is bounded (10s, 32KB cap). */
function executeLocalTool(name: string, args: Record<string, unknown>): string {
  if (name === "read_file") {
    const p = String(args.path ?? "")
    if (!p) throw new Error("missing 'path'")
    return fs.readFileSync(p, "utf8").slice(0, 32_000)
  }
  if (name === "bash") {
    const cmd = String(args.command ?? "")
    if (!cmd) throw new Error("missing 'command'")
    const out = execFileSync(cmd, {
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      timeout: 10_000,
      maxBuffer: 32_768,
      windowsHide: true,
    } as never)
    return String(out).slice(0, 32_000)
  }
  if (name === "grep" || name === "glob" || name === "write_file") {
    throw new Error(`${name} is not executed by mcp-server (use the CLI tools instead)`)
  }
  throw new Error(`unknown tool: ${name}`)
}

export async function dispatchMcpServer(req: {
  id?: unknown
  method: string
  params?: Record<string, unknown>
}): Promise<void> {
  switch (req.method) {
    case "initialize":
      send(req.id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "trayambak", version: "0.6.0" }, // keep in sync with root package.json
        capabilities: { tools: {} },
      })
      break
    case "tools/list":
      send(req.id, { tools: TOOLS })
      break
    case "tools/call": {
      const name = (req.params ?? {}).name as string
      const args = ((req.params ?? {}).arguments ?? {}) as Record<string, unknown>
      const found = TOOLS.find((t) => t.name === name)
      if (!found) sendError(req.id, -32602, `unknown tool: ${name}`)
      else {
        try {
          const text = executeLocalTool(name, args)
          send(req.id, { content: [{ type: "text", text }] })
        } catch (err) {
          send(req.id, {
            content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          })
        }
      }
      break
    }
    case "resources/list":
      send(req.id, { resources: [] })
      break
    case "prompts/list":
      send(req.id, { prompts: [] })
      break
    default:
      sendError(req.id, -32601, `unknown method: ${req.method}`)
  }
}

export function runMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on("line", (line) => {
    if (!line.trim()) return
    try {
      const req = JSON.parse(line) as { id?: unknown; method: string; params?: Record<string, unknown> }
      dispatchMcpServer(req).catch((err) => sendError(req.id, -32000, String(err)))
    } catch {
      /* malformed */
    }
  })
}

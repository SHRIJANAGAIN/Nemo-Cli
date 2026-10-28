/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn, type ChildProcess } from "child_process"
import { getConnectorRegistry } from "./registry.js"
import { resolveMcpCommand } from "../../../../../packages/mcp/src/spawn-resolve.js"
import { MCP_MAX_BUFFER_BYTES, type McpServerSpec } from "../../../../../packages/mcp/src/index.js"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, type ToolResult } from "../types.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class McpProcess {
  readonly name: string
  readonly spec: McpServerSpec
  private child: ChildProcess | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private initialized = false
  private stderrLines: string[] = []
  private lastError: string = ""

  constructor(name: string, spec: McpServerSpec) {
    this.name = name
    this.spec = spec
  }

  private get timeoutMs(): number {
    return this.spec.timeoutMs ?? 60_000
  }

  async connect(): Promise<void> {
    if (this.initialized) return
    const init = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nemo", version: "0.3.0" },
    }
    this.spawnStdio()
    await this.request("initialize", init)
    // Spec-required handshake (strict servers ignore calls until they see it).
    if (this.child) {
      try {
        this.child.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
        )
      } catch {
        /* best effort */
      }
    }
    this.initialized = true
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect()
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] }
    return result?.tools ?? []
  }

  async listResources(): Promise<Array<{ uri: string; name: string; mimeType?: string; description?: string }>> {
    await this.connect()
    try {
      const result = (await this.request("resources/list", {})) as {
        resources?: Array<{ uri: string; name: string; mimeType?: string; description?: string }>
      }
      return result?.resources ?? []
    } catch {
      return []
    }
  }

  async listPrompts(): Promise<Array<{ name: string; description?: string }>> {
    await this.connect()
    try {
      const result = (await this.request("prompts/list", {})) as {
        prompts?: Array<{ name: string; description?: string }>
      }
      return result?.prompts ?? []
    } catch {
      return []
    }
  }

  async status(): Promise<{
    name: string
    connected: boolean
    transport: "stdio" | "http" | "disconnected"
    initialized: boolean
  }> {
    const connected = this.child !== null && this.child.exitCode === null && !this.child.killed
    let transport: "stdio" | "http" | "disconnected" = "disconnected"
    if (connected) transport = "stdio"
    return {
      name: this.name,
      connected,
      transport,
      initialized: this.initialized && connected,
    }
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ name: string; messages: Array<{ role: "user" | "assistant" | "system"; content: unknown }> } | null> {
    await this.connect()
    try {
      const result = (await this.request("prompts/get", { name, arguments: args ?? {} })) as {
        messages?: Array<{ role: "user" | "assistant" | "system"; content: unknown }>
        prompt?: { messages?: Array<{ role: "user" | "assistant" | "system"; content: unknown }> }
      }
      const messages = result?.messages ?? result?.prompt?.messages
      if (!messages) return null
      return { name, messages }
    } catch {
      return null
    }
  }

  async readResource(uri: string): Promise<string> {
    await this.connect()
    try {
      const result = (await this.request("resources/read", { uri })) as {
        contents?: Array<{ text?: string; blob?: string; mimeType?: string }>
      }
      if (result?.contents) {
        return result.contents
          .map((c) =>
            typeof c.text === "string"
              ? c.text
              : typeof c.blob === "string"
                ? `[binary ${c.mimeType ?? "blob"}]`
                : JSON.stringify(c),
          )
          .join("\n")
      }
      return ""
    } catch {
      return ""
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect()
    return this.request("tools/call", { name, arguments: args })
  }

  close(): void {
    const child = this.child
    this.child = null
    this.initialized = false
    this.rejectAll(new Error(`MCP ${this.name} connection closed`))
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM")
      const killer = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }, 2000)
      if (typeof killer.unref === "function") killer.unref()
    }
  }

  getStderrLines(): string[] {
    return this.stderrLines
  }

  private spawnStdio(): void {
    const spec = this.spec
    const raw: string[] = spec.command ?? []
    if (raw.length === 0) throw new Error(`MCP server '${this.name}' has no command`)
    // Same shim resolution as the client (see spawn-resolve.ts): bare npx
    // fails with ENOENT from GUI shells, *.cmd fails with EINVAL.
    const { command: cmd, args } = resolveMcpCommand(raw)

    // No shell: argv passes straight through, so registry specs with
    // spaces/metachars can't inject (the old shell:true mis-split them).
    this.child = spawn(cmd, args, {
      cwd: spec.cwd ?? process.cwd(),
      // Filtered like hook children (hookChildEnv): MCP servers are
      // third-party code — they must not inherit API keys wholesale.
      // Operator-declared spec.env merges on top (explicit values win).
      env: { ...getSafeEnv(process.env), ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    })

    // Bounded newline framing (#82a): same contract as the client — a
    // server flooding stdout without a frame boundary fails the connection
    // instead of buffering unbounded (AGENTS 256KB output policy).
    let pending = ""
    let flooded = false
    const handleLine = (line: string): void => {
      try {
        const msg = JSON.parse(line) as { id?: number }
        if (msg.id === undefined) return
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        const resp = msg as JsonRpcResponse
        if (resp.error) waiter.reject(new Error(`MCP ${this.name}: ${resp.error.message}`))
        else waiter.resolve(resp.result)
      } catch {
        // ignore non-JSON lines
      }
    }
    this.child.stdout!.setEncoding("utf8")
    this.child.stdout!.on("data", (chunk: string) => {
      if (flooded) return
      pending += chunk
      let nl = pending.indexOf("\n")
      while (nl >= 0) {
        handleLine(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        nl = pending.indexOf("\n")
      }
      if (pending.length > MCP_MAX_BUFFER_BYTES) {
        flooded = true
        pending = ""
        this.lastError = `stdout flooded past ${MCP_MAX_BUFFER_BYTES} bytes with no frame boundary`
        this.rejectAll(
          new Error(
            `MCP ${this.name}: server flooded stdout past ${MCP_MAX_BUFFER_BYTES} bytes without a frame boundary`,
          ),
        )
        this.close()
      }
    })

    if (this.child.stderr) {
      this.child.stderr.on("data", (data: Buffer) => {
        const text = data.toString()
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim().slice(-500)
          if (trimmed) this.stderrLines.push(trimmed)
        }
        // Bounded: a chatty server must not OOM a long session.
        if (this.stderrLines.length > 50) {
          this.stderrLines.splice(0, this.stderrLines.length - 50)
        }
      })
    }

    this.child.on("error", (err) => this.rejectAll(new Error(`MCP ${this.name} process error: ${err.message}`)))
    this.child.on("exit", (code) => {
      // Any exit invalidates the transport (stale handle reported
      // connected:true and later calls hung on timeout).
      const tail = this.stderrLines.slice(-5).join(" | ").slice(0, 500)
      // A flood kill must keep ITS reason visible (the exit is our own SIGTERM).
      if (!flooded) this.lastError = `exited with code ${code ?? "signal"}`
      this.child = null
      this.initialized = false
      this.rejectAll(
        new Error(`MCP ${this.name} exited with code ${code ?? "signal"}.${tail ? ` Server stderr: ${tail}` : ""}`),
      )
    })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) throw new Error(`MCP '${this.name}' is not connected`)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.name}: timeout on '${method}'`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
      this.child!.stdin!.write(JSON.stringify(payload) + "\n")
    })
  }

  private rejectAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err)
    this.pending.clear()
  }
}

const mcpProcesses = new Map<string, McpProcess>()

export function getMcpProcess(name: string, spec: McpServerSpec): McpProcess {
  let process = mcpProcesses.get(name)
  // Recreate on spec change (edited command/env used to stick silently).
  if (process && JSON.stringify(process.spec) !== JSON.stringify(spec)) {
    process.close()
    mcpProcesses.delete(name)
    process = undefined
  }
  if (!process) {
    process = new McpProcess(name, spec)
    mcpProcesses.set(name, process)
  }
  return process
}

const MCP_ACTIONS = [
  "list_tools",
  "call_tool",
  "connect",
  "disconnect",
  "status",
  "list_resources",
  "list_prompts",
  "get_prompt",
  "read_resource",
] as const

type McpAction = (typeof MCP_ACTIONS)[number]

/**
 * Spellings a model reaches for instead of the exact action name. Rejecting
 * them wasted a whole turn: the call never reached the tool body, so the
 * model got no list of what WAS possible and simply retried.
 */
const MCP_ACTION_ALIASES: Record<string, McpAction> = {
  list: "list_tools",
  tools: "list_tools",
  tool_list: "list_tools",
  run: "call_tool",
  call: "call_tool",
  invoke: "call_tool",
  start: "connect",
  stop: "disconnect",
  health: "status",
  resources: "list_resources",
  prompts: "list_prompts",
  prompt: "get_prompt",
  read: "read_resource",
  resource: "read_resource",
}

const MCP_ACTION_ENUM: string[] = [...MCP_ACTIONS, ...Object.keys(MCP_ACTION_ALIASES)]

function normalizeMcpAction(action: string): McpAction | undefined {
  const lower = action.toLowerCase().trim()
  if ((MCP_ACTIONS as readonly string[]).includes(lower)) return lower as McpAction
  return MCP_ACTION_ALIASES[lower]
}

/**
 * Servers a session can actually reach: what the config declares plus the
 * built-in catalog. Installed servers live in `config.mcpServers` — the
 * registry alone could never run them.
 */
function knownServerIds(context?: ToolContext): string[] {
  const ids = new Set<string>(Object.keys(context?.config?.mcpServers ?? {}))
  for (const entry of getConnectorRegistry().load()) ids.add(entry.id)
  return [...ids]
}

function resolveMcpServerSpec(serverId: string, context?: ToolContext): McpServerSpec | undefined {
  const configured = context?.config?.mcpServers?.[serverId]
  if (configured) return configured as McpServerSpec
  return getConnectorRegistry().get(serverId)?.spec
}

function availableServersHint(context?: ToolContext, limit = 15): string {
  const ids = knownServerIds(context)
  if (ids.length === 0) return "No MCP servers are configured. Use mcp__install to add one."
  const shown = ids.slice(0, limit)
  const more = ids.length > shown.length ? `\n  …and ${ids.length - shown.length} more` : ""
  return `Available MCP servers: ${shown.join(", ")}${more}`
}

export function createMcpRunnerTool(): Tool {
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name: "nemo__run_mcp",
    description:
      "Run an installed MCP server, list its tools, resources, and prompts, and invoke them. Use this to run and think with MCP servers.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: MCP_ACTION_ENUM,
          description:
            "Action: list_tools (list tools), call_tool (invoke), connect (start), disconnect (stop), status (health), list_resources (list resources), list_prompts (list prompts), get_prompt (get prompt), read_resource (read resource). Short aliases (list, tools, call, run, start, stop, health, resources, prompts, prompt, read) are accepted too.",
        },
        server: {
          type: "string",
          description: "MCP server ID (e.g. sequential-thinking, github, filesystem).",
        },
        tool: {
          type: "string",
          description: "Tool name to invoke (for call_tool action).",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool (for call_tool action).",
        },
        uri: {
          type: "string",
          description: "Resource URI (for read_resource action).",
        },
        name: {
          type: "string",
          description: "Prompt or resource name (for get_prompt / list_prompts actions).",
        },
      },
    },
  }

  return {
    definition,
    async execute(_id, args, _signal, _update, context?: ToolContext): Promise<ToolResult> {
      const rawAction = String(args.action ?? "")
      const action = normalizeMcpAction(rawAction)
      if (!action) {
        return textResult(
          `Unknown action '${rawAction}'. Valid actions: ${MCP_ACTIONS.join(", ")}.`,
          /*isError*/ true,
        )
      }
      const serverId = args.server as string | undefined

      if (action === "status" && !serverId) {
        const ids = knownServerIds(context)
        if (ids.length === 0) {
          return textResult("No MCP servers are configured. Use mcp__install to add one.", /*isError*/ true)
        }
        const shown = ids.slice(0, 20)
        const lines: string[] = []
        for (const id of shown) {
          const running = mcpProcesses.get(id)
          if (!running) {
            lines.push(`  ${id}: not running`)
            continue
          }
          const status = await running.status()
          lines.push(
            `  ${id}: connected=${status.connected} transport=${status.transport} initialized=${status.initialized}`,
          )
        }
        if (ids.length > shown.length) lines.push(`  …and ${ids.length - shown.length} more`)
        return textResult(`MCP server status:\n${lines.join("\n")}`)
      }

      if (action === "list_tools" || action === "connect" || action === "status") {
        if (!serverId) {
          // "list" was almost always meant as "which servers are there?".
          // Answering that is far more useful than an error the model can
          // only retry against the same missing argument.
          if (action === "list_tools") {
            return textResult(
              `No 'server' given. ${availableServersHint(context)}\nPass one of these as "server" to list its tools.`,
            )
          }
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        }
        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )

        const process = getMcpProcess(serverId, spec)
        try {
          if (action === "connect") {
            await process.connect()
            return textResult(`Connected to MCP server '${serverId}'.`)
          }

          if (action === "status") {
            const status = await process.status()
            const lines = [
              `MCP server '${serverId}' status:`,
              `  connected: ${status.connected}`,
              `  transport: ${status.transport}`,
              `  initialized: ${status.initialized}`,
            ]
            return textResult(lines.join("\n"))
          }

          const tools = await process.listTools()
          if (tools.length === 0) {
            return textResult(`MCP server '${serverId}' is connected but exposes no tools.`)
          }
          const lines = tools.map((t) => `- ${t.name}: ${t.description ?? "(no description)"}`)
          return textResult(`MCP server '${serverId}' tools:\n${lines.join("\n")}`)
        } catch (err) {
          const stderr = process.getStderrLines().slice(-5).join("\n")
          const message = err instanceof Error ? err.message : String(err)
          return textResult(
            `MCP ${serverId}: ${message}${stderr ? `\nServer stderr:\n${stderr}` : ""}`,
            /*isError*/ true,
          )
        }
      }

      if (action === "call_tool") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const toolName = args.tool as string | undefined
        const toolArgs = (args.args ?? {}) as Record<string, unknown>
        if (!toolName) return textResult("Missing 'tool' parameter.", /*isError*/ true)

        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )

        const process = getMcpProcess(serverId, spec)
        try {
          const result = await process.callTool(toolName, toolArgs)
          const text = ((result as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n")
          return textResult(text || "(empty MCP result)")
        } catch (err) {
          const stderr = process.getStderrLines().slice(-5).join("\n")
          const message = err instanceof Error ? err.message : String(err)
          return textResult(
            `MCP ${serverId}.${toolName}: ${message}${stderr ? `\nServer stderr:\n${stderr}` : ""}`,
            /*isError*/ true,
          )
        }
      }

      if (action === "disconnect") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const process = mcpProcesses.get(serverId)
        if (!process) return textResult(`MCP server '${serverId}' is not running.`)
        process.close()
        mcpProcesses.delete(serverId)
        return textResult(`Disconnected MCP server '${serverId}'.`)
      }

      if (action === "list_resources") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )
        const process = getMcpProcess(serverId, spec)
        try {
          const resources = await process.listResources()
          if (resources.length === 0) return textResult(`MCP server '${serverId}' exposes no resources.`)
          const lines = resources.map((r) => `- ${r.name}: ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""}`)
          return textResult(`MCP server '${serverId}' resources:\n${lines.join("\n")}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return textResult(`MCP ${serverId} resources: ${message}`, /*isError*/ true)
        }
      }

      if (action === "list_prompts") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )
        const process = getMcpProcess(serverId, spec)
        try {
          const prompts = await process.listPrompts()
          if (prompts.length === 0) return textResult(`MCP server '${serverId}' exposes no prompts.`)
          const lines = prompts.map((p) => `- ${p.name}: ${p.description ?? "(no description)"}`)
          return textResult(`MCP server '${serverId}' prompts:\n${lines.join("\n")}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return textResult(`MCP ${serverId} prompts: ${message}`, /*isError*/ true)
        }
      }

      if (action === "get_prompt") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const promptName = args.name as string | undefined
        if (!promptName) return textResult("Missing 'name' parameter.", /*isError*/ true)
        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )
        const process = getMcpProcess(serverId, spec)
        try {
          const promptArgs =
            typeof args.args === "object" && args.args !== null ? (args.args as Record<string, string>) : undefined
          const prompt = await process.getPrompt(promptName, promptArgs)
          if (!prompt) return textResult(`Prompt '${promptName}' not found on server '${serverId}'.`, /*isError*/ true)
          const text = prompt.messages
            .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
            .join("\n")
          return textResult(text || "(empty prompt)")
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return textResult(`MCP ${serverId} prompt: ${message}`, /*isError*/ true)
        }
      }

      if (action === "read_resource") {
        if (!serverId)
          return textResult(`Missing 'server' parameter.\n${availableServersHint(context)}`, /*isError*/ true)
        const uri = args.uri as string | undefined
        if (!uri) return textResult("Missing 'uri' parameter.", /*isError*/ true)
        const spec = resolveMcpServerSpec(serverId, context)
        if (!spec)
          return textResult(
            `MCP server '${serverId}' is not available.\n${availableServersHint(context)}`,
            /*isError*/ true,
          )
        const process = getMcpProcess(serverId, spec)
        try {
          const content = await process.readResource(uri)
          return textResult(content || "(empty resource)")
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return textResult(`MCP ${serverId} resource read: ${message}`, /*isError*/ true)
        }
      }

      return textResult(
        `Unknown action: ${rawAction}. Valid actions: ${MCP_ACTIONS.join(", ")}.`,
        /*isError*/ true,
      )
    },
  }
}

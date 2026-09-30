/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import {
  createMcpConnection,
  type McpConnection,
  type McpServerSpec,
  type McpToolInfo,
  type McpResourceInfo,
  type McpPromptInfo,
  McpError,
} from "../../../../../packages/mcp/src/index.js"
import type { ToolDefinition, ToolParameterProperty } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolResult } from "../types.js"

export interface McpRegistryEntry {
  name: string
  spec: McpServerSpec
  conn?: McpConnection
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
}

const registry = new Map<string, McpRegistryEntry>()

/**
 * Build tools exposed by configured MCP (Model Context Protocol) servers.
 * Each remote tool is surfaced as `mcp__<server>__<tool>` so the agent can use
 * it through the normal tool-calling flow.
 */
export async function createMcpTools(
  mcpServers: Record<string, McpServerSpec> = {},
  cacheTtlMs?: number,
): Promise<Tool[]> {
  const out: Tool[] = []
  for (const [serverName, spec] of Object.entries(mcpServers)) {
    let entry = registry.get(serverName)
    // Recreate the connection when the spec changed (URL/headers/env edits
    // used to require a full restart — the old entry silently survived).
    if (entry && JSON.stringify(entry.spec) !== JSON.stringify(spec)) {
      entry.conn?.close()
      registry.delete(serverName)
      entry = undefined
    }
    if (!entry) {
      entry = {
        name: serverName,
        spec,
        conn: createMcpConnection(serverName, spec),
        tools: [],
        resources: [],
        prompts: [],
      }
      registry.set(serverName, entry)
    }
    const hadTools = entry.tools.length > 0
    try {
      entry.tools = await entry.conn!.listTools(cacheTtlMs)
      entry.resources = await entry.conn!.listResources()
      entry.prompts = await entry.conn!.listPrompts()
    } catch (err) {
      // Transient failure must not wipe a working toolset: keep serving the
      // last-known tools and surface the error alongside them.
      out.push(makeMcpErrorTool(serverName, err instanceof Error ? err.message : String(err)))
      if (!hadTools) continue
    }
    for (const t of entry.tools) out.push(makeMcpCallTool(serverName, t))
    for (const r of entry.resources) out.push(makeMcpReadResourceTool(serverName, r))
    for (const p of entry.prompts) out.push(makeMcpGetPromptTool(serverName, p))
  }
  return out
}

/** Sanitize a resource URI / prompt name into a tool-name suffix. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
  return slug || "item"
}

export function toToolProperty(raw: unknown): ToolParameterProperty {
  const p = (raw ?? {}) as {
    type?: ToolParameterProperty["type"]
    description?: string
    enum?: string[]
    items?: unknown
  }
  const out: ToolParameterProperty = {
    type: p.type ?? "string",
    description: p.description ?? "",
  }
  if (Array.isArray(p.enum)) out.enum = p.enum.filter((e): e is string => typeof e === "string")
  if (p.items && typeof p.items === "object") out.items = toToolProperty(p.items)
  return out
}

/** Reject with an abort error when the signal fires mid-call. */
function abortable<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new Error("aborted"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}

function makeMcpCallTool(server: string, info: McpToolInfo): Tool {
  const name = `mcp__${server}__${info.name}`
  const schema = (info.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] }
  const properties: Record<string, ToolParameterProperty> = {}
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    properties[k] = toToolProperty(v)
  }
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description: `Call tool '${info.name}' on MCP server '${server}'. ${info.description ?? ""}`.trim(),
    parameters: {
      type: "object",
      properties,
      required: (schema.required ?? []) as string[],
    },
  }
  return {
    definition,
    async execute(_id, args, signal, _update): Promise<ToolResult> {
      const entry = registry.get(server)
      if (!entry) return textResult(`MCP server '${server}' is not registered.`, /*isError*/ true)
      try {
        const result = await abortable(signal, entry.conn!.callTool(info.name, args as Record<string, unknown>))
        const text = (result.content ?? [])
          .map((c) =>
            typeof c.text === "string" ? c.text : c.blob ? `[binary ${c.mimeType ?? "blob"}]` : JSON.stringify(c),
          )
          .join("\n")
        return textResult(text || "(empty MCP result)", Boolean(result.isError))
      } catch (err) {
        if (err instanceof McpError) {
          return textResult(`mcp ${server}.${info.name} [${err.code}]: ${err.message}`, /*isError*/ true)
        }
        return textResult(
          `mcp ${server}.${info.name}: ${err instanceof Error ? err.message : String(err)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

function makeMcpReadResourceTool(server: string, resource: McpResourceInfo): Tool {
  const name = `mcp__${server}__read_resource_${slugify(resource.uri)}`
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description:
      `Read resource '${resource.name}' (${resource.uri}) from MCP server '${server}'. ${resource.description ?? ""}`.trim(),
    parameters: {
      type: "object",
      required: [],
      properties: {
        uri: { type: "string", description: `Resource URI (default ${resource.uri})` },
      },
    },
  }
  return {
    definition,
    async execute(_id, args, signal, _update): Promise<ToolResult> {
      const entry = registry.get(server)
      if (!entry) return textResult(`MCP server '${server}' is not registered.`, /*isError*/ true)
      const uri = typeof args.uri === "string" ? args.uri : resource.uri
      try {
        const content = await abortable(signal, entry.conn!.readResource(uri))
        return textResult(content || "(empty resource)")
      } catch (err) {
        if (err instanceof McpError) {
          return textResult(`mcp ${server} resource read [${err.code}]: ${err.message}`, /*isError*/ true)
        }
        return textResult(
          `mcp ${server} resource read: ${err instanceof Error ? err.message : String(err)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

function makeMcpGetPromptTool(server: string, prompt: McpPromptInfo): Tool {
  const name = `mcp__${server}__get_prompt_${slugify(prompt.name)}`
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description: `Get prompt '${prompt.name}' from MCP server '${server}'. ${prompt.description ?? ""}`.trim(),
    parameters: {
      type: "object",
      required: [],
      properties: {
        name: { type: "string", description: `Prompt name (default ${prompt.name})` },
        args: { type: "object", description: "Optional prompt arguments." },
      },
    },
  }
  return {
    definition,
    async execute(_id, args, signal, _update): Promise<ToolResult> {
      const entry = registry.get(server)
      if (!entry) return textResult(`MCP server '${server}' is not registered.`, /*isError*/ true)
      const promptName = typeof args.name === "string" ? args.name : prompt.name
      const promptArgs =
        typeof args.args === "object" && args.args !== null ? (args.args as Record<string, string>) : undefined
      try {
        const prompt = await abortable(signal, entry.conn!.getPrompt(promptName, promptArgs))
        if (!prompt) return textResult(`Prompt '${promptName}' not found on server '${server}'.`, /*isError*/ true)
        const text = prompt.messages
          .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
          .join("\n")
        return textResult(text || "(empty prompt)")
      } catch (err) {
        if (err instanceof McpError) {
          return textResult(`mcp ${server} prompt get [${err.code}]: ${err.message}`, /*isError*/ true)
        }
        return textResult(
          `mcp ${server} prompt get: ${err instanceof Error ? err.message : String(err)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

function makeMcpErrorTool(server: string, message: string): Tool {
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name: `mcp__${server}__error`,
    description: `MCP server '${server}' failed to initialize: ${message}.`,
    parameters: { type: "object", properties: {}, required: [] },
  }
  return {
    definition,
    async execute(): Promise<ToolResult> {
      return textResult(`MCP server '${server}' is unavailable: ${message}`, /*isError*/ true)
    },
  }
}

export function resetMcpRegistry(): void {
  for (const [, e] of registry) e.conn?.close()
  registry.clear()
}

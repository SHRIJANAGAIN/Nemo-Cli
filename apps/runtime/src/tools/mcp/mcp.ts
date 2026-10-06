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
import { evaluatePolicy, ExecDecision } from "../../../../../packages/execpolicy/src/policy.js"
import { textResult, type Tool, type ToolResult } from "../types.js"
import { containsInstructionOverride } from "../../agent/prompt-guard.js"

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
 *
 * Every stdio server command passes the exec-policy gate first (#62): the
 * default deny rules (sudo, rm -rf, mkfs, pipe-to-shell, …) block the spawn
 * and surface as `mcp__<server>__error` instead of running it. `Ask` is
 * treated as config-trusted standing approval — the same model as hook
 * commands (no approver exists at tool-build time, and skipping every
 * server the default policy doesn't explicitly name would deaden MCP
 * entirely); users can still add explicit deny rules to refuse a server.
 * `decide` is injectable for tests; production uses the default policy.
 */
export async function createMcpTools(
  mcpServers: Record<string, McpServerSpec> = {},
  cacheTtlMs?: number,
  decide: (command: string) => ExecDecision = evaluatePolicy,
): Promise<Tool[]> {
  const out: Tool[] = []
  const uniqueName = nameAllocator()
  for (const [serverName, spec] of Object.entries(mcpServers)) {
    const cmdLine = (spec.command ?? []).join(" ")
    if (cmdLine.length > 0 && decide(cmdLine) === ExecDecision.Deny) {
      // Fail closed even for a previously-connected server: close the stale
      // connection and drop it from the registry, or the old tools linger.
      registry.get(serverName)?.conn?.close()
      registry.delete(serverName)
      out.push(makeMcpErrorTool(serverName, `exec policy denies: ${cmdLine}`, uniqueName))
      continue
    }
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
      out.push(makeMcpErrorTool(serverName, err instanceof Error ? err.message : String(err), uniqueName))
      if (!hadTools) continue
    }
    for (const t of entry.tools) out.push(makeMcpCallTool(serverName, t, uniqueName))
    for (const r of entry.resources) out.push(makeMcpReadResourceTool(serverName, r, uniqueName))
    for (const p of entry.prompts) out.push(makeMcpGetPromptTool(serverName, p, uniqueName))
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

/* ───────────────── untrusted server-supplied metadata ───────────────── */

/** Cap on a server-supplied description. The description is part of the tool
 *  definition the provider receives on EVERY request, so an unbounded string is
 *  a per-turn cost and a way to push everything else out of the context. */
const MCP_DESCRIPTION_MAX_CHARS = 2000

/** Cap on server-supplied tool-result text before it enters the transcript.
 *  `truncateOutput` is applied by the shell, multi-search and pentest tools;
 *  the MCP surfaces skipped it, so a chatty server could flood the session. */
const MCP_RESULT_MAX_CHARS = 256 * 1024

/** Cap on the number of `required` entries accepted from a server schema. */
const MCP_MAX_REQUIRED = 64

/** Cap on a server-supplied identifier echoed into a description. */
const MCP_DISPLAY_NAME_MAX_CHARS = 80

/**
 * Render a server-supplied identifier for the trusted part of a description.
 *
 * `describeTools` takes only the first line, but in `nativeTools` mode the full
 * description reaches the provider — so an identifier containing newlines would
 * still forge extra prompt lines even though the catalogue NAME is slugified.
 * Collapse whitespace and cap the length.
 */
function safeDisplayName(raw: unknown): string {
  const flat = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim()
  if (flat.length === 0) return "(unnamed)"
  return flat.length > MCP_DISPLAY_NAME_MAX_CHARS ? `${flat.slice(0, MCP_DISPLAY_NAME_MAX_CHARS)}…` : flat
}

/**
 * Build a tool description around server-controlled text.
 *
 * Everything after `prefix` was chosen by the MCP server, i.e. by a third party
 * the user installed. In `nativeTools` mode it is forwarded verbatim as part of
 * the tool definition the model treats as authoritative, and
 * `annotateUntrustedToolResult` never sees it — that guard only covers tool
 * RESULTS. So withhold the text outright when it trips the instruction-override
 * guard, and cap it otherwise. Note the guard is a narrow phrase matcher, not a
 * sandbox: this raises the cost of a lazy or sloppy server, it does not make
 * server metadata safe to obey.
 */
function serverDescription(prefix: string, raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (text.length === 0) return prefix
  if (containsInstructionOverride(text)) {
    return `${prefix} [server-supplied description withheld: it contained instruction-override phrasing]`
  }
  if (text.length > MCP_DESCRIPTION_MAX_CHARS) {
    return `${prefix} ${text.slice(0, MCP_DESCRIPTION_MAX_CHARS)}… [description truncated]`
  }
  return `${prefix} ${text}`
}

/** Cap server-supplied result text before it joins the transcript. */
export function capMcpResultText(text: string): string {
  if (text.length <= MCP_RESULT_MAX_CHARS) return text
  const note = `\n[MCP result truncated: ${text.length} characters, showing first ${MCP_RESULT_MAX_CHARS}]`
  return text.slice(0, MCP_RESULT_MAX_CHARS) + note
}

/**
 * Validate a server-supplied `required` list. The value reached this code via
 * `as string[]`, so a server returning `[1, null, {a: 1}]` produced a malformed
 * tool definition that was forwarded to the provider verbatim.
 */
export function sanitizeRequired(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, MCP_MAX_REQUIRED)
}

/**
 * Allocate a unique tool name. Server-supplied names are slugified, which is a
 * many-to-one mapping (`Foo Bar` and `foo-bar` both become `foo_bar`), so a
 * second server could otherwise overwrite an earlier tool in the catalogue.
 */
function nameAllocator(): (name: string) => string {
  const used = new Set<string>()
  return (name: string): string => {
    if (!used.has(name)) {
      used.add(name)
      return name
    }
    let n = 2
    while (used.has(`${name}_${n}`)) n++
    const next = `${name}_${n}`
    used.add(next)
    return next
  }
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

function makeMcpCallTool(server: string, info: McpToolInfo, uniqueName: (n: string) => string): Tool {
  // The catalogue name is slugified, but dispatch still uses the server's real
  // tool name — `slugify` is many-to-one and would break `tools/call`.
  const remoteName = typeof info.name === "string" ? info.name : ""
  const name = uniqueName(`mcp__${server}__${slugify(remoteName)}`)
  const schema = (info.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: unknown }
  const properties: Record<string, ToolParameterProperty> = {}
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    properties[k] = toToolProperty(v)
  }
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description: serverDescription(
      `Call tool '${safeDisplayName(remoteName)}' on MCP server '${server}'.`,
      info.description,
    ),
    parameters: {
      type: "object",
      properties,
      required: sanitizeRequired(schema.required),
    },
  }
  return {
    definition,
    async execute(_id, args, signal, _update): Promise<ToolResult> {
      const entry = registry.get(server)
      if (!entry) return textResult(`MCP server '${server}' is not registered.`, /*isError*/ true)
      try {
        const result = await abortable(signal, entry.conn!.callTool(remoteName, args as Record<string, unknown>))
        const text = (result.content ?? [])
          .map((c) =>
            typeof c.text === "string" ? c.text : c.blob ? `[binary ${c.mimeType ?? "blob"}]` : JSON.stringify(c),
          )
          .join("\n")
        return textResult(capMcpResultText(text) || "(empty MCP result)", Boolean(result.isError))
      } catch (err) {
        if (err instanceof McpError) {
          return textResult(
            `mcp ${server}.${safeDisplayName(info.name)} [${err.code}]: ${err.message}`,
            /*isError*/ true,
          )
        }
        return textResult(
          `mcp ${server}.${safeDisplayName(info.name)}: ${err instanceof Error ? err.message : String(err)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

function makeMcpReadResourceTool(server: string, resource: McpResourceInfo, uniqueName: (n: string) => string): Tool {
  const name = uniqueName(`mcp__${server}__read_resource_${slugify(resource.uri)}`)
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description: serverDescription(
      `Read resource '${safeDisplayName(resource.name)}' (${safeDisplayName(resource.uri)}) from MCP server '${server}'.`,
      resource.description,
    ),
    parameters: {
      type: "object",
      required: [],
      properties: {
        uri: { type: "string", description: `Resource URI (default ${safeDisplayName(resource.uri)})` },
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
        return textResult(capMcpResultText(content) || "(empty resource)")
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

function makeMcpGetPromptTool(server: string, prompt: McpPromptInfo, uniqueName: (n: string) => string): Tool {
  const name = uniqueName(`mcp__${server}__get_prompt_${slugify(prompt.name)}`)
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name,
    description: serverDescription(
      `Get prompt '${safeDisplayName(prompt.name)}' from MCP server '${server}'.`,
      prompt.description,
    ),
    parameters: {
      type: "object",
      required: [],
      properties: {
        name: { type: "string", description: `Prompt name (default ${safeDisplayName(prompt.name)})` },
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
        return textResult(capMcpResultText(text) || "(empty prompt)")
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

function makeMcpErrorTool(server: string, message: string, uniqueName: (n: string) => string): Tool {
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name: uniqueName(`mcp__${server}__error`),
    description: `MCP server '${server}' failed to initialize: ${safeDisplayName(message)}.`,
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

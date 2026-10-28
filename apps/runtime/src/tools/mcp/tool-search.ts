/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolResult } from "../types.js"
import { getConnectorRegistry } from "./registry.js"
import { loadConfig, saveConfig } from "../../config.js"

const searchDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "tool_search",
  description: "Search for available tools and MCP connectors. Use this to discover what tools are available.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for tools/connectors" },
      prefix: { type: "string", description: "Filter by prefix ('mcp-' or 'mcp__')" },
      select: { type: "string", description: "Select/install a connector by id" },
    },
    required: [],
  },
}

const installedServers = new Set<string>()

export function createToolSearchTool(): Tool {
  const registry = getConnectorRegistry()
  registry.load()

  return {
    definition: searchDef,
    async execute(_id, args, _signal, _onUpdate) {
      const query = (args.query as string | undefined)?.trim()
      const prefix = (args.prefix as string | undefined)?.trim()
      const select = (args.select as string | undefined)?.trim()

      if (select) {
        return handleSelect(select, registry)
      }

      if (prefix === "mcp-" || prefix === "mcp__") {
        return handleMcpPrefix(registry)
      }

      if (query) {
        return handleSearch(query, registry)
      }

      return handleAll(registry)
    },
  }
}

function handleMcpPrefix(registry: ReturnType<typeof getConnectorRegistry>): ToolResult {
  const connectors = registry.load()
  const lines = connectors.map((c) => `- mcp__${c.id}: ${c.name} — ${c.description}`)
  return textResult(`Found ${connectors.length} MCP connectors:\n\n${lines.join("\n")}`)
}

function handleSearch(query: string, registry: ReturnType<typeof getConnectorRegistry>): ToolResult {
  const results = registry.search(query)
  if (results.length === 0) {
    return textResult(`No connectors or tools found matching '${query}'.`)
  }

  const lines = results.map((c) => {
    const status = installedServers.has(c.id) ? "connected" : "available"
    const kw = c.keywords?.slice(0, 5).join(", ")
    return `- **mcp__${c.id}** (${status}) — ${c.name}: ${c.description}\n  Keywords: ${kw ?? "none"}\n  Category: ${c.category ?? "uncategorized"}`
  })

  return textResult(
    `Found ${results.length} matching connector(s) for '${query}':\n\n${lines.join("\n\n")}\n\n` +
      `To connect one, use: nemo__ToolSearch with select="${results[0].id}"`,
  )
}

function handleAll(registry: ReturnType<typeof getConnectorRegistry>): ToolResult {
  const connectors = registry.load()
  const categories = registry.getCategories()
  const lines = connectors.map((c) => `- mcp__${c.id}: ${c.name} (${c.category ?? "uncategorized"})`)
  const catLines = categories.map(
    (cat) =>
      `  - ${cat}: ${registry
        .getByCategory(cat)
        .map((c) => c.id)
        .join(", ")}`,
  )

  return textResult(
    `Connector registry has ${connectors.length} servers across ${categories.length} categories:\n\n` +
      `${lines.join("\n")}\n\nCategories:\n${catLines.join("\n")}`,
  )
}

function handleSelect(select: string, registry: ReturnType<typeof getConnectorRegistry>): ToolResult {
  const parts = select
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const loaded: string[] = []
  const errors: string[] = []

  for (const part of parts) {
    const serverId = part.startsWith("mcp__") ? part.slice(5) : part
    const conn = registry.get(serverId)
    if (!conn) {
      errors.push(`Unknown connector: ${part}`)
      continue
    }
    // Actually wire it: persist into config.mcpServers so the server is
    // built and connected (the old code only flipped a display-only set).
    try {
      const cfg = loadConfig()
      const servers = { ...(cfg.mcpServers ?? {}) }
      if (!servers[serverId]) {
        servers[serverId] = {
          ...(conn.spec.command ? { command: conn.spec.command } : {}),
          ...(conn.spec.url ? { url: conn.spec.url } : {}),
          ...(conn.spec.env ? { env: conn.spec.env } : {}),
          ...(conn.spec.headers ? { headers: conn.spec.headers } : {}),
          ...(conn.spec.cwd ? { cwd: conn.spec.cwd } : {}),
          ...(conn.spec.timeoutMs ? { timeoutMs: conn.spec.timeoutMs } : {}),
        }
        saveConfig({ mcpServers: servers })
      }
      installedServers.add(serverId)
      loaded.push(`mcp__${serverId} (${conn.name})`)
    } catch (err) {
      errors.push(`Could not save ${serverId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let msg = `Loaded ${loaded.length} MCP connector(s):\n${loaded.map((l) => `- ${l}`).join("\n")}`
  if (loaded.length > 0) {
    msg += `\n\nRestart the session (or reconnect) for the new tools to appear.`
  }
  if (errors.length > 0) {
    msg += `\n\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}`
  }
  return textResult(msg, errors.length > 0)
}

export function getInstalledServers(): Set<string> {
  return installedServers
}

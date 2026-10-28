/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/mcp` — MCP (Model Context Protocol) server management from the terminal.
 *
 * Extracted from `App.tsx` (which exceeded the 4000-line `max-file-size`
 * cap): the old `case "mcp"` only printed dead usage rows — list/add/remove
 * did nothing, so configured servers were the only path and there was no
 * way to turn one on from the TUI. Same factory shape as `devmode-command`:
 * mutable surface (agentConfigRef, agentRef) comes in explicitly so tests
 * drive the flow with plain stubs.
 *
 * The behavioural contract this module owns:
 *
 *  - Every accepted change persists to config AND patches `agentConfigRef`,
 *    then nulls `agentRef` so the next message rebuilds the agent with the
 *    new servers live. No restart is ever required.
 *  - Adds are verified BEFORE they persist: a server nobody can connect to
 *    reports its error and leaves config untouched — a failure never
 *    mutates state; it reports state-accurately.
 */

import { createAgentConfig } from "./app-bootstrap.js"
import { loadConfig, saveConfig, type NemoConfig } from "../../../../apps/runtime/src/config.js"
import { createMcpTools } from "../../../../apps/runtime/src/tools/mcp/mcp.js"
import {
  installMcpServer,
  listAvailableMcpServers,
  searchMcpServers,
} from "../../../../apps/runtime/src/tools/mcp/mcp-install.js"
import type { McpServerSpec } from "../../../../packages/mcp/src/index.js"

export interface McpDeps {
  /** Post a system row into the transcript. */
  addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
  /** Live agent config, patched in place so the next turn sees the change. */
  agentConfigRef: { current: NemoConfig | null }
  /** Nulled to force an agent rebuild on the next message. */
  agentRef: { current: unknown }
  /** Config as loaded at boot; used only as the `createAgentConfig` seed. */
  config: Partial<NemoConfig> | null
}

const USAGE =
  "Usage: /mcp [list|search <q>|install <id>|add <name> <url|command...>|remove <name>|test <name>] — " +
  "list shows configured servers, search/install use the connector registry, add wires a custom server (verified before saving), test connects on demand."

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

function describeSpec(spec: McpServerSpec): string {
  if (spec.url) return `url ${spec.url}`
  if (spec.command?.length) return `stdio ${(spec.command ?? []).join(" ")}`
  return "unconfigured transport"
}

/** Persist an mcpServers map AND arm the agent rebuild that makes it live. */
function syncMcpServers(
  servers: Record<string, McpServerSpec>,
  deps: Pick<McpDeps, "agentConfigRef" | "agentRef" | "config">,
): void {
  saveConfig({ mcpServers: servers })
  deps.agentConfigRef.current = {
    ...(deps.agentConfigRef.current ?? createAgentConfig(deps.config ?? {})),
    mcpServers: loadConfig().mcpServers,
  }
  deps.agentRef.current = null // rebuild on the next run (same pattern as a model switch)
}

/** Usable tools from a connect, excluding the per-server error carrier. */
function usableTools(tools: Array<{ definition: { name: string } }>, server: string): string[] {
  return tools.map((t) => t.definition.name).filter((n) => n !== `mcp__${server}__error`)
}

function errorText(tools: Array<{ definition: { name: string; description: string } }>, server: string): string {
  const err = tools.find((t) => t.definition.name === `mcp__${server}__error`)
  return err ? err.definition.description : "connection failed with no detail"
}

/**
 * Run `/mcp <args>`. Returns nothing — every observable effect is either a
 * config write or a system row, so callers stay side-effect free.
 */
export function runMcp(rawArgs: string, deps: McpDeps): void {
  const { addSystemMessage } = deps
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? "list").toLowerCase()
  const rest = parts.slice(1)

  if (sub === "list" || sub === "ls") {
    const servers = loadConfig().mcpServers ?? {}
    const names = Object.keys(servers)
    const installable = listAvailableMcpServers().length
    if (names.length === 0) {
      addSystemMessage(
        `MCP servers: none configured — the agent has no mcp__* tools. ` +
          `Wire one: /mcp search <q> + /mcp install <id> (registry, ${installable} known) ` +
          `or /mcp add <name> <url|command...>.`,
      )
      return
    }
    const lines = names.map((n) => `  ${n} — ${describeSpec(servers[n] as McpServerSpec)}`)
    addSystemMessage(
      `MCP servers (${names.length} configured, live as mcp__<server>__* from the next message):\n${lines.join("\n")}\n` +
        `Registry holds ${installable} installable servers (/mcp search <q>). Verify one: /mcp test <name>.`,
    )
    return
  }

  if (sub === "search") {
    const q = rest.join(" ").trim()
    if (!q) {
      addSystemMessage("Usage: /mcp search <query> — e.g. /mcp search github")
      return
    }
    const hits = searchMcpServers(q).slice(0, 15)
    if (hits.length === 0) {
      addSystemMessage(
        `MCP registry: nothing matches "${q}". Try /mcp install <id> with an id from /mcp search <broader word>.`,
      )
      return
    }
    addSystemMessage(
      `MCP registry matches:\n${hits.map((h) => `  ${h.id} — ${h.description}`).join("\n")}\nInstall one: /mcp install <id>.`,
    )
    return
  }

  if (sub === "install") {
    const id = (rest[0] ?? "").trim()
    if (!id) {
      addSystemMessage("Usage: /mcp install <id> — find ids with /mcp search <q>")
      return
    }
    addSystemMessage(`Installing MCP server '${id}'…`)
    const cwd = deps.config?.cwd ?? process.cwd()
    void installMcpServer(id, cwd, loadConfig())
      .then((r) => {
        if (r.status === "failed") {
          addSystemMessage(`MCP install failed — ${r.message} (nothing changed).`)
          return
        }
        syncMcpServers(loadConfig().mcpServers ?? {}, deps)
        addSystemMessage(`${r.message} Live as mcp__${id}__* from the next message.`)
      })
      .catch((err: unknown) => {
        addSystemMessage(`MCP install failed — ${err instanceof Error ? err.message : String(err)} (nothing changed).`)
      })
    return
  }

  if (sub === "add") {
    const name = (rest[0] ?? "").trim()
    const tail = rest.slice(1)
    if (!NAME_RE.test(name) || tail.length === 0) {
      addSystemMessage(
        "Usage: /mcp add <name> <url>  or  /mcp add <name> <command...> — e.g. /mcp add local npx -y @modelcontextprotocol/server-memory",
      )
      return
    }
    const existing = loadConfig().mcpServers ?? {}
    if (existing[name]) {
      addSystemMessage(
        `MCP server '${name}' already exists — /mcp remove ${name} first, or /mcp test ${name} to check it.`,
      )
      return
    }
    const spec: McpServerSpec =
      tail.length === 1 && /^(https?|wss?):\/\//i.test(tail[0] as string)
        ? { url: tail[0] as string }
        : { command: tail as string[] }
    addSystemMessage(`Connecting MCP server '${name}' (${describeSpec(spec)})…`)
    void createMcpTools({ [name]: spec })
      .then((tools) => {
        const usable = usableTools(tools, name)
        if (usable.length === 0) {
          addSystemMessage(`MCP server '${name}' unreachable — ${errorText(tools, name)} (nothing saved).`)
          return
        }
        syncMcpServers({ ...loadConfig().mcpServers, [name]: spec }, deps)
        const shown = usable.slice(0, 8).join(", ")
        addSystemMessage(
          `MCP server '${name}' ON — ${usable.length} tool${usable.length === 1 ? "" : "s"} live from the next message (${shown}${usable.length > 8 ? ", …" : ""}).`,
        )
      })
      .catch((err: unknown) => {
        addSystemMessage(
          `MCP server '${name}' unreachable — ${err instanceof Error ? err.message : String(err)} (nothing saved).`,
        )
      })
    return
  }

  if (sub === "remove" || sub === "rm") {
    const name = (rest[0] ?? "").trim()
    const servers = { ...(loadConfig().mcpServers ?? {}) }
    if (!name || !servers[name]) {
      const names = Object.keys(servers)
      addSystemMessage(
        name
          ? `MCP server '${name}' is not configured.${names.length ? ` Configured: ${names.join(", ")}.` : ""}`
          : `Usage: /mcp remove <name>${names.length ? ` — configured: ${names.join(", ")}` : " (none configured)"}.`,
      )
      return
    }
    delete servers[name]
    syncMcpServers(servers, deps)
    addSystemMessage(`MCP server '${name}' removed — its mcp__${name}__* tools leave with the next message.`)
    return
  }

  if (sub === "test" || sub === "info" || sub === "status") {
    const name = (rest[0] ?? "").trim()
    const spec = loadConfig().mcpServers?.[name] as McpServerSpec | undefined
    if (!name || !spec) {
      addSystemMessage(`Usage: /mcp test <name> — checks a configured server live.`)
      return
    }
    addSystemMessage(`Testing MCP server '${name}'…`)
    void createMcpTools({ [name]: spec })
      .then((tools) => {
        const usable = usableTools(tools, name)
        if (usable.length === 0) {
          addSystemMessage(`MCP server '${name}' OFFLINE — ${errorText(tools, name)}`)
          return
        }
        const shown = usable.slice(0, 8).join(", ")
        addSystemMessage(
          `MCP server '${name}' ONLINE — ${usable.length} tool${usable.length === 1 ? "" : "s"} (${shown}${usable.length > 8 ? ", …" : ""}).`,
        )
      })
      .catch((err: unknown) => {
        addSystemMessage(`MCP server '${name}' OFFLINE — ${err instanceof Error ? err.message : String(err)}`)
      })
    return
  }

  addSystemMessage(USAGE)
}

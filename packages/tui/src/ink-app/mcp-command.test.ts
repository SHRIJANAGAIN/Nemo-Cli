/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/mcp` contract tests (mcp-command.ts).
 *
 * The old `case "mcp"` only printed dead usage rows while the agent dropped
 * configured servers at rebuild — MCP was unwirable from the terminal AND
 * unloaded at runtime. These tests pin the two properties that matter:
 *
 *  1. **Every accepted change is live immediately.** A write persists to
 *     config AND patches `agentConfigRef` AND nulls `agentRef` so the next
 *     message rebuilds the agent — otherwise /mcp add would look done and
 *     change nothing until restart.
 *  2. **A failure never mutates state.** Unreachable servers, failed
 *     installs, and unknown names report state-accurately with config,
 *     refs, and messages proving nothing moved.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../../apps/runtime/src/config.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../apps/runtime/src/config.js")
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
  }
})

vi.mock("../../../../apps/runtime/src/tools/mcp/mcp.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../apps/runtime/src/tools/mcp/mcp.js")
  return {
    ...actual,
    createMcpTools: vi.fn(async () => []),
  }
})

vi.mock("../../../../apps/runtime/src/tools/mcp/mcp-install.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../apps/runtime/src/tools/mcp/mcp-install.js")
  return {
    ...actual,
    listAvailableMcpServers: vi.fn(() => []),
    searchMcpServers: vi.fn(() => []),
    installMcpServer: vi.fn(async () => ({ status: "failed", message: "not mocked" })),
  }
})

import { runMcp, type McpDeps } from "./mcp-command.js"
import { createAgentConfig } from "./app-bootstrap.js"
import { loadConfig, saveConfig } from "../../../../apps/runtime/src/config.js"
import { createMcpTools } from "../../../../apps/runtime/src/tools/mcp/mcp.js"
import {
  installMcpServer,
  listAvailableMcpServers,
  searchMcpServers,
} from "../../../../apps/runtime/src/tools/mcp/mcp-install.js"

const loadMock = loadConfig as unknown as ReturnType<typeof vi.fn>
const saveMock = saveConfig as unknown as ReturnType<typeof vi.fn>
const toolsMock = createMcpTools as unknown as ReturnType<typeof vi.fn>
const installMock = installMcpServer as unknown as ReturnType<typeof vi.fn>
const searchMock = searchMcpServers as unknown as ReturnType<typeof vi.fn>
const availMock = listAvailableMcpServers as unknown as ReturnType<typeof vi.fn>

interface Harness extends McpDeps {
  rows: string[]
}

function harness(base: Record<string, unknown> = {}): Harness {
  const rows: string[] = []
  loadMock.mockImplementation(() => base)
  return {
    rows,
    addSystemMessage: (content) => {
      rows.push(content)
      return content
    },
    // Built by the REAL createAgentConfig (app-bootstrap.js, not mocked here)
    // so the stub is a genuine 19-field NemoConfig. A Partial cast would
    // satisfy the compiler but hide the fact that these tests never exercised
    // the merge-onto-existing-config path. `current` stays non-null so line
    // ~141's "patch merged onto a live config" assertion stays meaningful.
    agentConfigRef: { current: createAgentConfig({ provider: "nvidia" }) },
    agentRef: { current: { sentinel: true } },
    config: null,
  }
}

const tool = (name: string, description = ""): { definition: { name: string; description: string } } => ({
  definition: { name, description },
})

/** Flush the fire-and-forget promise chains runMcp leaves behind. */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("runMcp list/search", () => {
  it("reports none configured with the way on, and lists transports when present", () => {
    availMock.mockReturnValue([])
    const empty = harness({})
    runMcp("", empty)
    expect(empty.rows.join("\n")).toContain("none configured")
    expect(empty.rows.join("\n")).toContain("/mcp add")
    expect(saveMock).not.toHaveBeenCalled()

    const full = harness({
      mcpServers: {
        gh: { command: ["npx", "-y", "x"] },
        cloud: { url: "https://example.com/mcp" },
      },
    })
    runMcp("list", full)
    const text = full.rows.join("\n")
    expect(text).toContain("gh — stdio npx -y x")
    expect(text).toContain("cloud — url https://example.com/mcp")
    expect(text).toContain("mcp__<server>__*")
  })

  it("searches the registry and nudges on empty query or no hits", () => {
    searchMock.mockReturnValue([{ id: "github", description: "GitHub API" }])
    const h = harness({})
    runMcp("search github", h)
    expect(h.rows.join("\n")).toContain("github — GitHub API")
    expect(h.rows.join("\n")).toContain("/mcp install")

    runMcp("search", harness({}))
    // usage row, no search performed
    expect(searchMock).toHaveBeenCalledTimes(1)
  })
})

describe("runMcp add", () => {
  it("verifies, saves, and reloads a reachable URL server", async () => {
    toolsMock.mockResolvedValue([tool("mcp__web__fetch"), tool("mcp__web__read")])
    const h = harness({})
    runMcp("add web https://example.com/mcp", h)
    await settle()
    expect(toolsMock).toHaveBeenCalledWith({ web: { url: "https://example.com/mcp" } })
    expect(saveMock).toHaveBeenCalledWith({ mcpServers: { web: { url: "https://example.com/mcp" } } })
    expect(h.agentConfigRef.current).toMatchObject({ provider: "nvidia" })
    expect(h.agentRef.current).toBeNull()
    expect(h.rows.join("\n")).toContain("ON — 2 tools live")
  })

  it("wires stdio commands and refuses to save unreachable servers", async () => {
    toolsMock.mockResolvedValue([tool("mcp__local__run")])
    const h = harness({})
    runMcp("add local npx -y some-server", h)
    await settle()
    expect(toolsMock).toHaveBeenCalledWith({ local: { command: ["npx", "-y", "some-server"] } })
    expect(saveMock).toHaveBeenCalled()

    toolsMock.mockResolvedValue([tool("mcp__dead__error", "MCP server 'dead' failed to initialize: ECONNREFUSED.")])
    saveMock.mockClear()
    const bad = harness({})
    runMcp("add dead https://down.example/mcp", bad)
    await settle()
    expect(saveMock).not.toHaveBeenCalled()
    expect(bad.agentRef.current).toEqual({ sentinel: true })
    expect(bad.rows.join("\n")).toContain("nothing saved")
  })

  it("rejects bad names, duplicates, and missing args without touching anything", () => {
    const dup = harness({ mcpServers: { web: { url: "https://example.com/mcp" } } })
    runMcp("add web https://other.example/mcp", dup)
    expect(toolsMock).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
    expect(dup.rows.join("\n")).toContain("already exists")

    const h = harness({})
    runMcp("add", h)
    runMcp("add 'bad name' x", h)
    expect(toolsMock).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe("runMcp remove/install/test", () => {
  it("removes configured servers and reloads, reports unknown names", () => {
    const h = harness({ mcpServers: { a: { url: "https://a.example" }, b: { command: ["x"] } } })
    runMcp("remove a", h)
    expect(saveMock).toHaveBeenCalledWith({ mcpServers: { b: { command: ["x"] } } })
    expect(h.agentRef.current).toBeNull()
    expect(h.rows.join("\n")).toContain("removed")

    const missing = harness({ mcpServers: { b: { command: ["x"] } } })
    runMcp("remove nope", missing)
    expect(saveMock).toHaveBeenCalledTimes(1) // no second write
    expect(missing.rows.join("\n")).toContain("not configured")
  })

  it("installs from the registry and reloads on success only", async () => {
    installMock.mockResolvedValue({ server: "github", status: "installed", message: "installed github" })
    const h = harness({})
    runMcp("install github", h)
    await settle()
    // syncMcpServers re-saves the (install-persisted) map and reloads.
    expect(saveMock).toHaveBeenCalledWith({ mcpServers: {} })
    expect(h.agentRef.current).toBeNull()
    expect(h.rows.join("\n")).toContain("installed github")

    installMock.mockResolvedValue({ server: "nope", status: "failed", message: "unknown id" })
    saveMock.mockClear()
    const bad = harness({})
    runMcp("install nope", bad)
    await settle()
    expect(bad.agentRef.current).toEqual({ sentinel: true })
    expect(bad.rows.join("\n")).toContain("nothing changed")
  })

  it("tests live servers and reports offline ones honestly", async () => {
    toolsMock.mockResolvedValue([tool("mcp__gh__search"), tool("mcp__gh__error", "stale")])
    const h = harness({ mcpServers: { gh: { command: ["x"] } } })
    runMcp("test gh", h)
    await settle()
    expect(h.rows.join("\n")).toContain("ONLINE — 1 tool")

    toolsMock.mockResolvedValue([tool("mcp__gh__error", "MCP server 'gh' failed to initialize: boom.")])
    const off = harness({ mcpServers: { gh: { command: ["x"] } } })
    runMcp("test gh", off)
    await settle()
    expect(off.rows.join("\n")).toContain("OFFLINE")
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("answers unknown subcommands with usage", () => {
    const h = harness({})
    runMcp("frobnicate", h)
    expect(h.rows.join("\n")).toContain("Usage: /mcp")
  })
})

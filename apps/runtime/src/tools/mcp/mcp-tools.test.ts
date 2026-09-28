/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createMcpConnection } from "../../../../../packages/mcp/src/index.js"
import { createMcpTools, resetMcpRegistry, slugify, toToolProperty } from "./mcp.js"
import { resolveInstalledEntry } from "./mcp-install.js"

/**
 * MCP client + tool-exposure fixes, proven against a fake stdio server:
 * initialized notification, cursor pagination, flat prompts/get shape,
 * unique resource/prompt tool names, full schema passthrough.
 */

const SERVER_SCRIPT = `
const readline = require("readline");
const fs = require("fs");
const log = process.env.MCP_TEST_LOG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) {
    if (msg.method && log) fs.appendFileSync(log, msg.method + "\\n");
    return;
  }
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.method === "initialize") return respond({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } });
  if (msg.method === "tools/list") {
    if (!msg.params || !msg.params.cursor) return respond({ tools: [{ name: "alpha", description: "first", inputSchema: { type: "object", properties: { q: { type: "string", description: "query", enum: ["a", "b"] } }, required: ["q"] } }], nextCursor: "c1" });
    return respond({ tools: [{ name: "beta", description: "second", inputSchema: { type: "object", properties: {} } }] });
  }
  if (msg.method === "resources/list") return respond({ resources: [{ uri: "file:///a.txt", name: "a" }, { uri: "file:///b.txt", name: "b" }] });
  if (msg.method === "prompts/list") return respond({ prompts: [{ name: "p1" }, { name: "p2" }] });
  if (msg.method === "prompts/get") return respond({ messages: [{ role: "user", content: "hello" }] });
  if (msg.method === "tools/call") return respond({ content: [{ type: "text", text: "called:" + msg.params.name }] });
  return respond({});
});
`

function startFakeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-mcp-"))
  const script = path.join(dir, "server.cjs")
  fs.writeFileSync(script, SERVER_SCRIPT)
  const log = path.join(dir, "notes.log")
  return { dir, script, log }
}

describe("McpConnection protocol fixes", () => {
  it("sends notifications/initialized and paginates tools/list", async () => {
    const { dir, script, log } = startFakeServer()
    try {
      const conn = createMcpConnection("fake", { command: [process.execPath, script], env: { MCP_TEST_LOG: log } })
      const tools = await conn.listTools(0)
      expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"])
      await new Promise((r) => setTimeout(r, 200))
      const notes = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""
      expect(notes).toContain("notifications/initialized")
      conn.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it("parses the flat prompts/get shape", async () => {
    const { dir, script } = startFakeServer()
    try {
      const conn = createMcpConnection("fake", { command: [process.execPath, script] })
      const prompt = await conn.getPrompt("p1")
      expect(prompt?.messages).toHaveLength(1)
      conn.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it("reports disconnected for a dead child", async () => {
    const { dir, script } = startFakeServer()
    try {
      const conn = createMcpConnection("fake", { command: [process.execPath, script] })
      await conn.connect()
      ;(conn as unknown as { child: { kill: (s: string) => void } }).child?.kill("SIGKILL")
      await new Promise((r) => setTimeout(r, 500))
      const status = await conn.status()
      expect(status.connected).toBe(false)
      conn.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})

describe("createMcpTools exposure fixes", () => {
  it("emits unique names per resource/prompt and keeps full schemas", async () => {
    const { dir, script } = startFakeServer()
    try {
      const tools = await createMcpTools({ fake: { command: [process.execPath, script] } }, 0)
      const names = tools.map((t) => t.definition.name)
      expect(new Set(names).size).toBe(names.length)
      expect(names).toContain("mcp__fake__read_resource_file_a_txt")
      expect(names).toContain("mcp__fake__get_prompt_p1")
      const alpha = tools.find((t) => t.definition.name === "mcp__fake__alpha")
      const q = alpha?.definition.parameters.properties.q
      expect(q?.type).toBe("string")
      expect(q?.enum).toEqual(["a", "b"])
      resetMcpRegistry()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it("slugify/toToolProperty helpers behave", () => {
    expect(slugify("file:///a.txt")).toBe("file_a_txt")
    expect(slugify("")).toBe("item")
    expect(toToolProperty({ type: "integer", description: "n", enum: ["x", 1] }).enum).toEqual(["x"])
    expect(toToolProperty(undefined).type).toBe("string")
  })

  it("resolveInstalledEntry finds dist/index.js payloads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-mcp-inst-"))
    try {
      const dist = path.join(dir, "node_modules", "some-pkg", "dist")
      fs.mkdirSync(dist, { recursive: true })
      fs.writeFileSync(path.join(dist, "index.js"), "x")
      expect(resolveInstalledEntry(dir, "some-pkg")).toEqual({
        command: ["node", path.join(dist, "index.js")],
      })
      expect(resolveInstalledEntry(dir, "missing-pkg")).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

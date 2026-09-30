/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryTool, memoryFile, saveMemory, useMemoryFile } from "./memory.js"

// memoryFile() resolves os.homedir() at CALL time; point the whole home at a
// fixed temp dir so this regression test never touches the developer's real
// ~/.trayambak/memory/ tree — and so "fresh profile" is actually fresh.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>()
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = join(tmpdir(), "trayambak-memory-test-home")
  return { ...actual, homedir: () => home }
})

const homeDir = os.homedir()
const projectDir = path.join(os.tmpdir(), "trayambak-memory-test-proj")

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n")
}

describe("saveMemory on a fresh profile", () => {
  beforeEach(() => {
    // Neither tree exists: homedir/.trayambak/memory/ nor <project>/skt/4-mem/.
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "memory-test" }))
    process.env.TRAYAMBAK_HOME = projectDir
  })

  afterEach(() => {
    delete process.env.TRAYAMBAK_HOME
  })

  it("creates BOTH directory trees instead of throwing ENOENT on memory.json", () => {
    expect(fs.existsSync(path.dirname(memoryFile()))).toBe(false)
    expect(fs.existsSync(path.dirname(useMemoryFile()))).toBe(false)

    expect(() => saveMemory([])).not.toThrow()

    expect(fs.existsSync(memoryFile())).toBe(true)
    expect(fs.existsSync(useMemoryFile())).toBe(true)
  })

  it("memory save → search roundtrip works before any directory exists", async () => {
    const tool = createMemoryTool()

    const saved = await tool.execute("t1", { action: "save", title: "probe", content: "fresh profile fact" }, undefined)
    expect(saved.isError).toBe(false)
    expect(textOf(saved)).toMatch(/^Saved mem_/)

    const found = await tool.execute("t2", { action: "search", query: "fresh profile" }, undefined)
    expect(found.isError).toBe(false)
    expect(textOf(found)).toContain("fresh profile fact")
  })
})

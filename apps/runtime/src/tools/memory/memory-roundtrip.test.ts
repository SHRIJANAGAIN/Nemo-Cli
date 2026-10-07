/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryTool, loadMemory } from "./memory.js"

// Point the whole home at a fixed temp dir so this test never touches the
// developer's real ~/.trayambak/memory/ tree.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>()
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = join(tmpdir(), "trayambak-memory-roundtrip-home")
  return { ...actual, homedir: () => home }
})

const homeDir = os.homedir()
const projectDir = path.join(os.tmpdir(), "trayambak-memory-roundtrip-proj")

beforeEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "memory-test" }))
  process.env.TRAYAMBAK_HOME = projectDir
})

afterEach(() => {
  delete process.env.TRAYAMBAK_HOME
})

describe("memory save → load round trip", () => {
  it("does not parse the header/schema illustration as real memory entries", async () => {
    const tool = createMemoryTool()
    const saved = await tool.execute("t1", { action: "save", title: "T", content: "hello world fact" }, undefined)
    expect(saved.isError).toBe(false)

    // serializeMemoryMd always prepends a header whose fenced schema block
    // contains a literal `### MEM-YYYYMMDD-NNN` line, and parseMemoryMd splits
    // on every /^### /m — the header text and the schema fragment used to come
    // back as two extra "entries", growing the store by 2 junk rows per save.
    const entries = loadMemory()
    expect(entries).toHaveLength(1) // RED: 3 (header junk + schema junk + real)
    // bodyMatch requires 6 metadata lines but the serializer writes 5, so
    // content used to fall back to "everything after the id" — the meta block.
    expect(entries[0]?.content).toBe("hello world fact") // RED: "- created: ...\n- category: ..."
  })
})
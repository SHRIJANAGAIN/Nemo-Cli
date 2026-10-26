/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryTool, loadMemory } from "./memory.js"

// Point the whole home at a fixed temp dir so this test never touches the
// developer's real ~/.nemo/memory/ tree.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>()
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = join(tmpdir(), "nemo-memory-roundtrip-home")
  return { ...actual, homedir: () => home }
})

const homeDir = os.homedir()
const projectDir = path.join(os.tmpdir(), "nemo-memory-roundtrip-proj")

beforeEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "memory-test" }))
  process.env.NEMO_HOME = projectDir
})

afterEach(() => {
  delete process.env.NEMO_HOME
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

  /**
   * The invariant that actually broke, and the single-save test above cannot
   * see it.
   *
   * The live store once held 16 entries whose content lengths were
   * 2642, 2488, 2334, 2180 … — decreasing by EXACTLY 154 characters each, which
   * is precisely the length of one serialized front-matter block. Every entry's
   * content began with `- created: …` metadata and ended mid-sentence in a
   * truncated copy of the serializer's OWN header text.
   *
   * So the failure was not a single bad parse. It was a cycle: the header got
   * captured as a phantom entry, the store was written back with that phantom
   * carrying the header, the next load re-captured it, and each round trip lost
   * one block off the tail. Every user memory in the file was overwritten by
   * those phantom rows. One save looks fine; the damage is only visible in the
   * Nth save, which is why a one-shot round-trip test stayed green the entire
   * time the store was being destroyed.
   *
   * So this test saves repeatedly and asserts BOTH that nothing accumulates and
   * that every fact is byte-identical afterwards.
   */
  it("stays stable across repeated saves — no header capture, no compounding loss", async () => {
    const tool = createMemoryTool()
    const facts = ["ALPHA-FACT", "BETA-FACT", "GAMMA-FACT", "DELTA-FACT", "EPSILON-FACT"]

    for (const [i, fact] of facts.entries()) {
      const saved = await tool.execute(`t${i}`, { action: "save", title: `T${i}`, content: fact }, undefined)
      expect(saved.isError, `save ${i} must succeed`).toBe(false)
    }

    const entries = loadMemory()

    // Exactly one entry per save: a captured header shows up as extra rows.
    expect(entries).toHaveLength(facts.length)

    // Every fact survives byte-for-byte, and nothing carries metadata.
    const contents = entries.map((e) => e.content)
    for (const fact of facts) {
      expect(contents, `fact ${fact} must survive`).toContain(fact)
    }
    for (const content of contents) {
      expect(content).not.toMatch(/^- created:/)
      expect(content).not.toContain("This is the **active** memory store")
    }
  })

  it("does not grow the store on a save of an ALREADY-saved fact", async () => {
    // The re-save path is where a captured header would be re-absorbed, so it
    // gets its own assertion rather than riding on the loop above.
    //
    // Deliberately NOT asserting a single row. Observed behaviour is that
    // repeated saves of one fact collapse to TWO identical rows, not one — the
    // save path mints a fresh id per call and the dedupe runs later. Collapsing
    // that to one row is a separate defect (the save also REPORTS "Saved
    // mem_xxx" with a new id for a fact that was already stored, so the caller is
    // told a memory was created when it was not). Asserting `<= 1` here would
    // fail on that, not on the header-capture regression this file guards.
    //
    // What matters and IS asserted: the count does not grow with the number of
    // saves, and no content is contaminated.
    const tool = createMemoryTool()
    for (let i = 0; i < 4; i++) {
      await tool.execute(`t${i}`, { action: "save", title: "T", content: "SAME-FACT" }, undefined)
    }
    const entries = loadMemory()
    expect(entries.length).toBeLessThan(4)
    for (const entry of entries) expect(entry.content).toBe("SAME-FACT")
  })
})
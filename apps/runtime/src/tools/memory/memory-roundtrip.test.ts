/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryTool, getContextBlock, loadMemory, memoryJsonPath, memoryMdPath } from "./memory.js"

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

  /**
   * The store's real file is USEMEMORY.MD, not the JSON sidecar — `loadMemory`
   * reads the MD first, so anything the MD format does not carry is lost on
   * every save/load cycle even though the JSON next to it still has it.
   *
   * The title was the visible symptom: `memory save` reported "Saved mem_x:
   * my-title" and then `memory list` printed "[mem_x] undefined". Tags, wiki
   * links and the `expires` frontmatter were dropped the same way — which
   * silently disabled tag-scored search and made the "drop expired entries"
   * consolidation a no-op.
   */
  it("keeps the title, tags, links and expiry across a save -> load round trip", async () => {
    const tool = createMemoryTool()
    const saved = await tool.execute(
      "t1",
      {
        action: "save",
        title: "Deploy ritual",
        content: "---\nexpires: 2999-01-01T00:00:00Z\n---\nTag the release before tagging the repo. See [[release-checklist]].",
        tags: "deploy,ritual",
      },
      undefined,
    )
    expect(saved.isError).toBe(false)

    const entries = loadMemory()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.title).toBe("Deploy ritual")
    expect(entry.tags).toEqual(["deploy", "ritual"])
    expect(entry.links).toContain("release-checklist")
    expect(entry.frontmatter?.expires).toBe("2999-01-01T00:00:00Z")
    expect(entry.content).toContain("Tag the release before tagging the repo.")
    expect(entry.content).not.toMatch(/^- created:/)
  })

  it("lists a saved memory with its title instead of 'undefined'", async () => {
    const tool = createMemoryTool()
    await tool.execute("t1", { action: "save", title: "Named Fact", content: "the body" }, undefined)
    const listed = await tool.execute("t2", { action: "list" }, undefined)
    const text = (listed.content[0] as { text: string }).text
    expect(text).toContain("Named Fact")
    expect(text).not.toContain("undefined")
  })
})

const MD_HEADER = `# Shrijan - User Memory (Active)

## Active entries

<!-- The assistant appends entries below. Do not edit by hand. -->

`

/** Write the store file directly, bypassing saveMemory (the cases below are
 *  about reading files the CURRENT writer never produced). */
function writeMdStore(body: string): void {
  const file = memoryMdPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, MD_HEADER + body, "utf8")
}

describe("legacy store recovery", () => {
  it("reads real entries out of a legacy-shaped store and repairs the file", () => {
    // The shipped store was written by the old serializer: the header prose
    // became a block of its own, and a lost entry's body was a second copy of
    // the metadata. Every one of those rows was then rejected by the id check,
    // so a 29 KB file loaded as ZERO memories — the store was silently dead for
    // every session, which is what made /resume look like it had no memory.
    writeMdStore(
      [
        "### # Nemo Code - User Memory (Active)",
        'This is the **active** memory store. When the user says "remember this"',
        "",
        "### MEM-20261001-00000001",
        "- created: 2026-10-01T10:00:00Z",
        "- category: preference",
        "- title: Gateway",
        "",
        "Only the NVIDIA gateway is allowed.",
        "",
        "### MEM-20261002-00000002",
        "- created: 2026-10-02T10:00:00Z",
        "- category: fact",
        "- created: 2026-10-02T10:00:00Z",
        "- category: fact",
      ].join("\n"),
    )

    const entries = loadMemory()
    expect(entries.map((e) => e.content)).toEqual(["Only the NVIDIA gateway is allowed."])
    expect(entries[0]?.title).toBe("Gateway")

    // Repaired in place: the phantom blocks are gone and the real entry is
    // still there, so the next load parses without dropping anything.
    const repaired = fs.readFileSync(memoryMdPath(), "utf8")
    expect(repaired).not.toContain("### # Nemo Code")
    expect(repaired).toContain("Only the NVIDIA gateway is allowed.")
    expect(loadMemory()).toHaveLength(1)
  })

  it("keeps a memory that survived only in the JSON sidecar", () => {
    // The MD store sits next to the install and can be read-only; the sidecar
    // is in the user's home and always writable. Reading the MD alone threw
    // away every memory whose MD write failed.
    writeMdStore(
      ["### MEM-00000001", "- created: 2026-10-01T00:00:00Z", "- category: fact", "", "md-only fact"].join("\n"),
    )
    fs.mkdirSync(path.dirname(memoryJsonPath()), { recursive: true })
    fs.writeFileSync(
      memoryJsonPath(),
      JSON.stringify([
        { id: "MEM-00000001", content: "md-only fact", createdAt: "2026-10-01T00:00:00Z", tags: [] },
        { id: "MEM-00000002", content: "sidecar-only fact", createdAt: "2026-10-05T00:00:00Z", tags: [] },
      ]),
      "utf8",
    )

    const contents = loadMemory().map((e) => e.content)
    // Merged by id, no duplicate, ordered oldest → newest so "the last N" is
    // "the newest N".
    expect(contents).toEqual(["md-only fact", "sidecar-only fact"])
  })

  it("lets a body that opens with a bullet survive the metadata heuristic", () => {
    // "- created:" is metadata; "- Fix the parser first" is a sentence. A
    // prefix test alone would drop the real memory.
    writeMdStore(["### MEM-00000003", "- created: 2026-10-03T00:00:00Z", "- category: fact", "", "- pin the lockfile before release"].join("\n"))

    expect(loadMemory().map((e) => e.content)).toEqual(["- pin the lockfile before release"])
  })
})

describe("query-ranked context", () => {
  it("includes the memory the resumed chat is about even when it is old", () => {
    // The block was the newest N entries and nothing else, so a resumed
    // conversation about the package manager got the three most recent,
    // unrelated notes — and the model answered as though it remembered nothing.
    const block = (n: number) =>
      [
        `### MEM-${String(n).padStart(8, "0")}`,
        `- created: 2026-09-0${n}T00:00:00Z`,
        `- category: fact`,
        `- title: T${n}`,
        "",
      ].join("\n")
    writeMdStore(
      [
        block(1) + "User prefers pnpm over npm",
        block(2) + "Deploys run in ap-south-1",
        block(3) + "The desk lamp flickers",
        block(4) + "Nights are for reading",
      ].join("\n\n"),
    )

    const plain = getContextBlock(3)
    const ranked = getContextBlock(3, "does the user prefer pnpm")

    expect(plain).not.toContain("pnpm")
    expect(ranked.split("\n")[1]).toContain("pnpm")
    expect(ranked.startsWith("## Persistent memory:")).toBe(true)
  })
})
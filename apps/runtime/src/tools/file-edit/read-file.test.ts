/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { createReadFileTool } from "./read-file.js"
import { loadFrecency, type FrecencyEntry } from "../../../../../packages/core/src/frecency.js"
import type { ToolContext } from "../types.js"

/**
 * `read_file` used to do `readFileSync(path, "utf8")` and slice to 50 KB only
 * AFTER the whole file was decoded. The cap therefore bounded the reply but not
 * the allocation, so pointing the tool at a huge file (a multi-GB build log) is
 * an out-of-memory kill of the agent process. These tests pin the bound.
 */

const dirs: string[] = []
function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

// `read_file` records each successful read into the frecency store, which lives
// in the per-user state dir. Without this the suite would write into the
// developer's real ~/.trayambak on every run, so the store is redirected into a
// throwaway directory. Set at module scope so every test in this file inherits
// it; vitest isolates the module registry per file, so nothing else observes it.
process.env.TRAYAMBAK_STATE_DIR = scratch("trayambak-readfile-state-")

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function ctxFor(cwd: string): ToolContext {
  return { cwd, config: {}, permissions: {} } as unknown as ToolContext
}

async function read(cwd: string, args: Record<string, unknown>): Promise<string> {
  const res = await createReadFileTool().execute("t1", args, undefined, undefined, ctxFor(cwd))
  const first = res.content[0]
  return first && first.type === "text" ? first.text : ""
}

/**
 * A sparse file: the directory entry claims `bytes`, but NTFS/ext4 allocate
 * almost nothing, so a 1 GB file costs no real disk and no 1 GB of test time.
 */
function sparseFile(file: string, bytes: number): void {
  const fd = fs.openSync(file, "w")
  try {
    fs.writeSync(fd, Buffer.from("head\n"), 0, 5, 0)
    // Extend the file length without writing the body.
    fs.ftruncateSync(fd, bytes)
  } finally {
    fs.closeSync(fd)
  }
}

describe("read_file bounded read (#75)", () => {
  it("reads a small file in full and reports its true line count", async () => {
    const dir = scratch("rf-small-")
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8")
    const out = await read(dir, { path: "a.txt" })
    // Trailing newline yields a final empty element; that split behaviour is
    // pre-existing and unchanged — the point here is that a small file is read
    // whole and is never labelled as truncated.
    expect(out).toContain("(4 lines)")
    expect(out).toContain("one")
    expect(out).toContain("three")
    expect(out).not.toContain("capped")
  })

  it("caps an oversized file at 50 KB and never materialises the whole thing", async () => {
    const dir = scratch("rf-big-")
    const file = path.join(dir, "big.log")
    // 1 GB claimed size. Before the fix this decoded ~1 GB into a JS string,
    // which blew past V8's max string length and surfaced as a read error.
    sparseFile(file, 1024 * 1024 * 1024)

    const out = await read(dir, { path: "big.log" })
    expect(out, "must not surface a read error").not.toContain("Read error")
    expect(out).toContain("head")
    expect(out).toContain("truncated")
    // The notice names the real on-disk size, so the model can tell a truncated
    // prefix from a whole file.
    expect(out).toMatch(/capped to 50 KB of 1073741824 bytes/)
    // Bounded means bounded: no megabytes of content in the reply.
    expect(out.length).toBeLessThan(200_000)
  }, 60_000)

  it("still honours offset/limit on a capped file", async () => {
    const dir = scratch("rf-slice-")
    fs.writeFileSync(path.join(dir, "b.txt"), "l1\nl2\nl3\nl4\nl5\n", "utf8")
    const out = await read(dir, { path: "b.txt", offset: 2, limit: 2 })
    expect(out).toContain("l2")
    expect(out).toContain("l3")
    expect(out).not.toContain("l4")
    expect(out).toContain("3 more lines")
  })

  it("refuses a path outside the workspace before reading anything", async () => {
    const dir = scratch("rf-deny-")
    const out = await read(dir, { path: path.join(path.parse(os.homedir()).root, "etc", "passwd") })
    expect(out).toContain("Access denied")
  })
})

describe("frecency recording", () => {
  /** The store the tool wrote, read back through the real loader. */
  function store(): FrecencyEntry[] {
    return loadFrecency(path.join(process.env.TRAYAMBAK_STATE_DIR ?? "", "frecency.json"))
  }

  it("records a successful read so the file can rank later", async () => {
    const dir = scratch("rf-frec-hit-")
    fs.writeFileSync(path.join(dir, "wanted.ts"), "export const a = 1\n", "utf8")
    const before = store().length
    await read(dir, { path: "wanted.ts" })
    const rows = store()
    expect(rows).toHaveLength(before + 1)
    expect(rows.map((e) => path.basename(e.path))).toContain("wanted.ts")
  })

  it("does NOT record a denied read — a blocked path is not a file being worked on", async () => {
    const before = store().length
    await read(scratch("rf-frec-deny-"), { path: path.join(path.parse(os.homedir()).root, "etc", "passwd") })
    expect(store()).toHaveLength(before)
  })

  it("does NOT record a missing file", async () => {
    const before = store().length
    await read(scratch("rf-frec-missing-"), { path: "absent.ts" })
    expect(store()).toHaveLength(before)
  })

  it("stores the RESOLVED absolute path, not the argument the model passed", async () => {
    // Ranking by the raw argument would bucket every relative read of the same
    // file under a different key, so the working set would never accumulate.
    const dir = scratch("rf-frec-abs-")
    fs.mkdirSync(path.join(dir, "sub"))
    fs.writeFileSync(path.join(dir, "sub", "deep.ts"), "deep\n", "utf8")
    await read(dir, { path: path.join("sub", "deep.ts") })
    expect(store().map((e) => e.path)).toContain(path.join(dir, "sub", "deep.ts"))
  })

  it("collapses a burst of reads into one open, so ranking survives a scan", async () => {
    // A single file scanned repeatedly must not out-rank everything forever.
    const dir = scratch("rf-frec-dedupe-")
    fs.writeFileSync(path.join(dir, "scanned.ts"), "x\n", "utf8")
    for (let i = 0; i < 6; i++) await read(dir, { path: "scanned.ts" })
    expect(store().find((e) => e.path.endsWith("scanned.ts"))?.opens).toBe(1)
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSummarizeTool } from "./summarize.js"

/** A real file on disk, so the tool takes its genuine read path. */
function fixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sumrange-"))
  const file = path.join(dir, "doc.md")
  fs.writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n", "utf8")
  return { dir, file }
}

async function run(args: Record<string, unknown>): Promise<string> {
  const res = await createSummarizeTool().execute("t1", args, undefined, undefined, {
    cwd: process.cwd(),
    config: {},
    permissions: {},
  } as never)
  const first = res.content[0]
  return first && first.type === "text" ? first.text : ""
}

describe("summarize lines range", () => {
  it("returns the requested range for a well-formed pair", async () => {
    const { file } = fixture()
    const out = await run({ file, lines: [2, 3] })
    expect(out).toContain("l2")
    expect(out).toContain("l3")
    expect(out).not.toContain("l1")
  })

  it("rejects an EMPTY array instead of silently returning nothing", async () => {
    // `Array.isArray([])` is true, so destructuring gave undefined bounds and
    // `slice(NaN, NaN)` produced an empty reply with no error at all.
    const { file } = fixture()
    const out = await run({ file, lines: [] })
    expect(out).toContain("Invalid 'lines'")
  })

  it("rejects a single-element array, which also yields an undefined bound", async () => {
    const { file } = fixture()
    expect(await run({ file, lines: [5] })).toContain("Invalid 'lines'")
  })

  it("rejects non-numeric bounds", async () => {
    const { file } = fixture()
    expect(await run({ file, lines: ["2", "3"] })).toContain("Invalid 'lines'")
    expect(await run({ file, lines: [null, 3] })).toContain("Invalid 'lines'")
  })

  it("rejects a reversed range rather than silently returning nothing", async () => {
    const { file } = fixture()
    const out = await run({ file, lines: [4, 2] })
    expect(out).toContain("is after end")
  })

  it("still clamps a valid range to the file's real length", async () => {
    const { file } = fixture()
    const out = await run({ file, lines: [1, 99] })
    expect(out).toContain("l1")
    expect(out).toContain("l5")
  })
})

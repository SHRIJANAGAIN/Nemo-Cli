/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createEditFileTool } from "./edit-file.js"
import type { ToolContext } from "../types.js"

function tmpCtx(): { dir: string; ctx: ToolContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-edit-"))
  return { dir, ctx: { cwd: dir } as unknown as ToolContext }
}

function resultText(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n")
}

describe("createEditFileTool fuzzy fallback", () => {
  it("applies a unique indentation-drifted match", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "f.txt"), "if (ok) {\n    run();\n}\n", "utf8")
    const tool = createEditFileTool()
    // Tab indent never occurs byte-exact (file uses spaces) → trim pass.
    const r = await tool.execute(
      "t1",
      { path: "f.txt", old_string: "\trun();", new_string: "walk();" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(resultText(r)).toContain("trim")
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("if (ok) {\nwalk();\n}\n")
  })

  it("keeps exact-match behavior untouched", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "f.txt"), "aaa\nbbb\n", "utf8")
    const tool = createEditFileTool()
    const r = await tool.execute(
      "t1",
      { path: "f.txt", old_string: "aaa", new_string: "zzz" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(resultText(r)).toContain("1 occurrence")
    expect(resultText(r)).not.toContain("match)")
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("zzz\nbbb\n")
  })

  it("still fails honestly when nothing matches at any pass", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "f.txt"), "aaa\n", "utf8")
    const tool = createEditFileTool()
    const r = await tool.execute(
      "t1",
      { path: "f.txt", old_string: "qqq zzz", new_string: "x" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("not found")
  })

  it("refuses ambiguous loose matches instead of guessing", async () => {
    const { dir, ctx } = tmpCtx()
    // Trailing spaces: no byte-exact hit, two trimEnd hits → must refuse.
    fs.writeFileSync(path.join(dir, "f.txt"), "  run(); \n  run(); \n", "utf8")
    const tool = createEditFileTool()
    const r = await tool.execute(
      "t1",
      { path: "f.txt", old_string: "run();", new_string: "walk();" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("not unique")
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("  run(); \n  run(); \n")
  })
})

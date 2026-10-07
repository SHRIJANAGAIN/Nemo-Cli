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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-edit-dollar-"))
  return { dir, ctx: { cwd: dir } as unknown as ToolContext }
}

describe("edit_file replacement-string literals", () => {
  it("keeps $& $` $' $$ literal instead of expanding them as a String.replace pattern", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "f.txt"), "abc\n", "utf8")
    const tool = createEditFileTool()
    const r = await tool.execute(
      "t1",
      { path: "f.txt", old_string: "abc", new_string: "price: $& and $` and $' and $$" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBeFalsy()
    // String.replace would expand $& → "abc", $` → "", $' → "\n", $$ → "$".
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("price: $& and $` and $' and $$\n")
  })
})
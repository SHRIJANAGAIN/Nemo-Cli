/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createWriteFileTool } from "./write-file.js"
import type { ToolContext } from "../types.js"

function tmpCtx(): { dir: string; ctx: ToolContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-write-"))
  return { dir, ctx: { cwd: dir } as unknown as ToolContext }
}

function resultText(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n")
}

describe("write_file line count", () => {
  it("counts a trailing newline as a terminator, not a phantom line", async () => {
    // read_file explicitly documents the trailing newline as a TERMINATOR
    // ("one\ntwo\nthree\n" reads back as (3 lines)); write_file's
    // `content.split("\n").length` counted the phantom 4th element. Round
    // trips therefore disagreed about "how many lines" the same file has.
    const { dir, ctx } = tmpCtx()
    const r = await createWriteFileTool().execute(
      "w",
      { path: "a.txt", content: "one\ntwo\nthree\n" },
      undefined,
      undefined,
      ctx,
    )
    expect(resultText(r)).toContain("Wrote 3 lines") // RED: "Wrote 4 lines"
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n")
  })
})
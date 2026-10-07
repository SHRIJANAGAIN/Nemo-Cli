/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createExtractTool, createSummarizeTool } from "./summarize.js"
import type { ToolResult } from "../../../../../packages/protocol/src/index.js"
import type { ToolContext } from "../types.js"

describe("summarize and extract byte caps", () => {
  let tmp = ""
  let originalCwd = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sumz-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const runSum = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createSummarizeTool().execute("call-1", args, undefined)
  const runExt = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createExtractTool().execute("call-1", args, undefined)
  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("flags a truncated source instead of silently summarizing a prefix", async () => {
    fs.writeFileSync(path.join(tmp, "big.md"), "alpha beta gamma delta. ".repeat(300_000))
    const res = await runSum({ file: "big.md" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toContain("source truncated")
  })

  it("flags that extract searched only the prefix", async () => {
    fs.writeFileSync(path.join(tmp, "big.log"), "line one\n".repeat(600_000))
    const res = await runExt({ file: "big.log", pattern: "zzz-not-there" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toContain("searched only the first")
  })

  it("summarizes inline text without touching a file", async () => {
    const res = await runSum({ text: "one two three four five six seven eight nine ten eleven twelve" })
    expect(res.isError).toBe(false)
    expect(textOf(res).length).toBeGreaterThan(0)
  })

  it("reports when neither file nor text is given", async () => {
    const res = await runSum({})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("Provide either a file or inline text")
  })
})

describe("summarize and extract resolve against the tool context cwd", () => {
  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("reads a relative file from ctx.cwd even when process.cwd() points elsewhere", async () => {
    // read_file honours ctx.cwd; these two used process.cwd() instead, so the
    // same relative path meant different files depending on which tool ran it.
    // The project dir is NOT the process cwd here — only the context says where
    // the workspace is.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sumz-ctx-"))
    try {
      fs.writeFileSync(path.join(dir, "doc.txt"), "Alpha beta gamma delta epsilon. Hello world.", "utf8")
      const ctx = { cwd: dir, config: {}, permissions: {} } as unknown as ToolContext
      const res = await createSummarizeTool().execute("call-1", { file: "doc.txt" }, undefined, undefined, ctx)
      expect(res.isError, textOf(res)).toBe(false)
      expect(textOf(res)).toContain("Alpha")
      const ext = await createExtractTool().execute(
        "call-1",
        { file: "doc.txt", pattern: "Alpha" },
        undefined,
        undefined,
        ctx,
      )
      expect(ext.isError, textOf(ext)).toBe(false)
      expect(textOf(ext)).toContain("Alpha")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

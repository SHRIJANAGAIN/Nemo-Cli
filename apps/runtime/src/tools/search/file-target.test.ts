/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGrepTool } from "../regex/grep.js"
import { createCodeSearchTool } from "../code-search/code-search.js"
import { createGlobTool } from "../globber/glob.js"
import { setRipgrepOverride } from "./ripgrep.js"
import type { ToolContext } from "../types.js"

/**
 * A search tool whose `path` names a FILE must still find the pattern.
 * Handing the backends a file where they expect a directory made every one
 * of them report "no matches" for a file that plainly contained the text —
 * a silent wrong answer, which is worse than an error.
 */

const FILE_CONTENT = ["const startServer = 1", "export function stopServer() {}", "const VERSION = '2.0'"].join("\n")

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-file-target-"))
  fs.writeFileSync(path.join(dir, "server.ts"), FILE_CONTENT)
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sub", "other.ts"), "const startServer = 2\n")
  return dir
}

describe.each([
  ["ripgrep", undefined],
  ["node fallback", null],
])("file-target search (%s)", (_label, override) => {
  let dir = ""

  beforeEach(() => {
    setRipgrepOverride(override as string | null | undefined)
    dir = makeDir()
  })

  afterEach(() => {
    setRipgrepOverride(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const ctx = (): ToolContext => ({ cwd: dir }) as ToolContext
  const file = (): string => path.join(dir, "server.ts")

  it("grep finds the pattern inside a single file", async () => {
    const res = await createGrepTool().execute(
      "t1",
      { pattern: "startServer", path: file() },
      undefined,
      undefined,
      ctx(),
    )
    expect(res.isError).toBe(false)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain("Found 1 match(es)")
    expect(text).toContain("server.ts:1:")
  })

  it("grep still reports a genuine miss on a file", async () => {
    const res = await createGrepTool().execute(
      "t2",
      { pattern: "zzz-never-here", path: file() },
      undefined,
      undefined,
      ctx(),
    )
    expect((res.content[0] as { text: string }).text).toContain("No matches for /zzz-never-here/")
  })

  it("code_search finds the identifier inside a single file", async () => {
    const res = await createCodeSearchTool().execute(
      "t3",
      { query: "stopServer", path: file() },
      undefined,
      undefined,
      ctx(),
    )
    expect(res.isError).toBe(false)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain("1 match(es) for 'stopServer'")
    expect(text).toContain("server.ts")
  })

  it("glob matches a file path against the pattern", async () => {
    const res = await createGlobTool().execute(
      "t4",
      { pattern: "*.ts", path: file() },
      undefined,
      undefined,
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect((res.content[0] as { text: string }).text).toContain("server.ts")
  })

  it("glob reports a file that does not match the pattern", async () => {
    const res = await createGlobTool().execute(
      "t5",
      { pattern: "*.json", path: file() },
      undefined,
      undefined,
      ctx(),
    )
    expect((res.content[0] as { text: string }).text).toContain("No files matched '*.json'")
  })
})

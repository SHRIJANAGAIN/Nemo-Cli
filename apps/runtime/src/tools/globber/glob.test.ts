/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createGlobTool } from "./glob.js"
import { resolveRipgrep, setRipgrepOverride } from "../search/ripgrep.js"
import type { ToolContext } from "../types.js"

/** Real binary if present — the rg-backed describe skips without it. */
const REAL_RG = resolveRipgrep()

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-glob-"))
  fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true })
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "")
  fs.writeFileSync(path.join(dir, "src", "deep", "b.ts"), "")
  fs.writeFileSync(path.join(dir, "root.ts"), "")
  fs.writeFileSync(path.join(dir, "notes.md"), "")
  fs.writeFileSync(path.join(dir, "node_modules", "junk", "x.ts"), "")
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "")
  return dir
}

/** Run the glob tool against `dir` and return its text output. */
async function runGlob(dir: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const res = await createGlobTool().execute("t1", args, undefined, undefined, { cwd: dir } as ToolContext)
  return { isError: res.isError, text: (res.content[0] as { text: string }).text }
}

/** Behaviour both backends must satisfy for the shared fixture. */
function assertSharedBehaviour(text: string): void {
  expect(text).toContain("3 file(s):")
  expect(text).toContain("root.ts")
  expect(text).toContain(path.join("src", "a.ts"))
  expect(text).toContain(path.join("src", "deep", "b.ts"))
  expect(text).not.toContain("node_modules")
  expect(text).not.toContain("notes.md")
}

describe("glob (Node fallback)", () => {
  let dir = ""

  beforeEach(() => {
    setRipgrepOverride(null)
    dir = makeFixture()
  })

  afterEach(() => {
    setRipgrepOverride(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("finds nested files by suffix glob and skips ignored dirs", async () => {
    const out = await runGlob(dir, { pattern: "**/*.ts" })
    expect(out.isError).toBe(false)
    assertSharedBehaviour(out.text)
  })

  it("includes hidden directories", async () => {
    const out = await runGlob(dir, { pattern: "**/*.yml" })
    expect(out.text).toContain(path.join(".github", "workflows", "ci.yml"))
  })

  it("reports when nothing matches", async () => {
    const out = await runGlob(dir, { pattern: "**/*.tsx" })
    expect(out.text).toBe("No files matched '**/*.tsx'")
  })
})

describe.skipIf(REAL_RG === null)("glob (ripgrep backend)", () => {
  let dir = ""

  beforeEach(() => {
    dir = makeFixture()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("finds nested files by suffix glob and skips ignored dirs", async () => {
    const out = await runGlob(dir, { pattern: "**/*.ts" })
    expect(out.isError).toBe(false)
    assertSharedBehaviour(out.text)
  })

  it("includes hidden directories", async () => {
    const out = await runGlob(dir, { pattern: "**/*.yml" })
    expect(out.text).toContain(path.join(".github", "workflows", "ci.yml"))
  })

  it("reports when nothing matches", async () => {
    const out = await runGlob(dir, { pattern: "**/*.tsx" })
    expect(out.text).toBe("No files matched '**/*.tsx'")
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createGrepTool, formatGrepHits } from "./grep.js"
import { resolveRipgrep, setRipgrepOverride, type RgHit } from "../search/ripgrep.js"
import type { ToolContext } from "../types.js"

/** Real binary if present — the rg-backed describe skips without it. */
const REAL_RG = resolveRipgrep()

/**
 * ReDoS guard: a pathological pattern on a mega-line must return fast
 * (skipped + reported), never block the event loop for minutes.
 *
 * Pinned to the pure-Node backend: the guard is a Node-engine property
 * (ripgrep's linear-time engine has no such hazard to guard against).
 */
describe("grep ReDoS guard", () => {
  let dir = ""
  const ctx = (): ToolContext => ({ cwd: dir }) as ToolContext

  beforeEach(() => {
    setRipgrepOverride(null)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-grep-"))
    fs.writeFileSync(path.join(dir, "normal.ts"), "hello world\nfoo bar\n")
    // Minified-style single mega-line ending in a NEAR-MISS: catastrophic
    // input for (a+)+$ (all-"a" would match fast; the trailing "b" forces
    // exponential backtracking without the guard).
    fs.writeFileSync(path.join(dir, "bundle.js"), "a".repeat(100_000) + "b")
  })

  afterEach(() => {
    setRipgrepOverride(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("skips over-long lines instead of hanging (evil pattern)", async () => {
    const tool = createGrepTool()
    const start = Date.now()
    const res = await tool.execute("t1", { pattern: "(a+)+$" }, undefined, undefined, ctx())
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10000)
    const text = JSON.stringify(res)
    expect(text).toContain("skipped")
  }, 15000)

  it("still finds normal matches", async () => {
    const tool = createGrepTool()
    const res = await tool.execute("t2", { pattern: "hello", glob: "*.ts" }, undefined, undefined, ctx())
    expect(JSON.stringify(res)).toContain("hello world")
  })
})

describe("formatGrepHits", () => {
  const hit = (p: string, line: number, text: string, isMatch = true): RgHit => ({ path: p, line, text, isMatch })

  it("renders matches as rel:line: text and caps at maxResults", () => {
    const hits = [hit("a.ts", 1, "  first  "), hit("b.ts", 4, "second")]
    const out = formatGrepHits(hits, { maxResults: 5, contextLines: 0 })
    expect(out.lines).toEqual(["a.ts:1: first", "b.ts:4: second"])
    expect(out.matchCount).toBe(2)
    expect(out.hasMore).toBe(false)
  })

  it("reports more matches when the cap is exceeded", () => {
    const hits = [hit("a.ts", 1, "one"), hit("a.ts", 2, "two"), hit("a.ts", 3, "three")]
    const out = formatGrepHits(hits, { maxResults: 2, contextLines: 0 })
    expect(out.matchCount).toBe(2)
    expect(out.hasMore).toBe(true)
  })

  it("indents context lines in stream order, including those before their match", () => {
    // rg emits a match's preceding context first, then the match itself.
    const hits = [hit("a.ts", 1, "before", false), hit("a.ts", 2, "match"), hit("a.ts", 3, "after", false)]
    const out = formatGrepHits(hits, { maxResults: 10, contextLines: 1 })
    expect(out.lines).toEqual(["  a.ts:1: before", "a.ts:2: match", "  a.ts:3: after"])
    expect(out.matchCount).toBe(1)
  })

  it("drops context once the match cap is reached", () => {
    const hits = [
      hit("a.ts", 1, "one"),
      hit("a.ts", 2, "ctx", false),
      hit("a.ts", 3, "two"),
      hit("a.ts", 4, "ctx2", false),
    ]
    const out = formatGrepHits(hits, { maxResults: 1, contextLines: 1 })
    expect(out.lines).toEqual(["a.ts:1: one"])
    expect(out.hasMore).toBe(true)
  })

  it("truncates over-long lines for display", () => {
    const out = formatGrepHits([hit("a.ts", 1, "x".repeat(9000))], { maxResults: 10, contextLines: 0 })
    expect(out.lines[0]).toContain("… [line truncated]")
    expect(out.lines[0].length).toBeLessThan(9000)
  })
})

describe.skipIf(REAL_RG === null)("grep via ripgrep backend", () => {
  let dir = ""
  const ctx = (): ToolContext => ({ cwd: dir }) as ToolContext

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-grep-rg-"))
    fs.writeFileSync(path.join(dir, "normal.ts"), "hello world\nfoo bar\n")
    fs.writeFileSync(path.join(dir, "bundle.js"), "a".repeat(100_000) + "b")
    fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true })
    fs.writeFileSync(path.join(dir, "node_modules", "junk", "hello.js"), "hello junk\n")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns the same output shape for normal matches", async () => {
    const res = await createGrepTool().execute("t1", { pattern: "hello", glob: "*.ts" }, undefined, undefined, ctx())
    expect(res.isError).toBe(false)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain("Found 1 match(es)")
    expect(text).toContain(`normal.ts:1: hello world`)
    expect(text).not.toContain("node_modules")
  })

  it("returns the no-match message when nothing hits", async () => {
    const res = await createGrepTool().execute("t2", { pattern: "zzz-never" }, undefined, undefined, ctx())
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain("No matches for /zzz-never/ in")
  })

  it("answers the pathological pattern fast through the linear-time engine", async () => {
    const start = Date.now()
    const res = await createGrepTool().execute("t3", { pattern: "(a+)+$" }, undefined, undefined, ctx())
    expect(Date.now() - start).toBeLessThan(10_000)
    expect(res.isError).toBe(false)
  }, 15000)

  it("matches literals containing regex metacharacters in literal mode", async () => {
    fs.writeFileSync(path.join(dir, "meta.ts"), "const re = /a.c/;\n")
    const res = await createGrepTool().execute("t4", { pattern: "/a.c/", literal: true }, undefined, undefined, ctx())
    expect((res.content[0] as { text: string }).text).toContain("meta.ts:1:")
  })
})

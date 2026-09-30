/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import {
  buildSemanticIndex,
  createSemanticSearchTool,
  formatSemanticResults,
  searchSemanticIndex,
  tokenize,
} from "./semantic-search.js"

describe("semantic-search pure helpers", () => {
  it("tokenizes lowercase alphanumerics without stopwords", () => {
    expect(tokenize("Session Resume Checkpoints!")).toEqual(["session", "resume", "checkpoints"])
    expect(tokenize("the and for")).toEqual([])
  })

  it("ranks the most similar doc first with deterministic ties", () => {
    const index = buildSemanticIndex([
      { path: "a/memory.ts", content: "memory store recall capture project memory" },
      { path: "b/server.ts", content: "http server listen port socket unrelated words here" },
    ])
    const hits = searchSemanticIndex(index, "project memory recall", 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toBe("a/memory.ts")
  })

  it("breaks score ties by path", () => {
    const index = buildSemanticIndex([
      { path: "b/same.ts", content: "identical words here" },
      { path: "a/same.ts", content: "identical words here" },
    ])
    const hits = searchSemanticIndex(index, "identical words", 10)
    expect(hits.map((h) => h.path)).toEqual(["a/same.ts", "b/same.ts"])
  })

  it("returns [] for empty queries or empty indexes", () => {
    const index = buildSemanticIndex([{ path: "a.ts", content: "hello world" }])
    expect(searchSemanticIndex(index, "   ", 10)).toEqual([])
    expect(searchSemanticIndex(buildSemanticIndex([]), "hello", 10)).toEqual([])
  })

  it("formats empty and capped results honestly", () => {
    expect(formatSemanticResults("q", [])).toContain("No semantically similar files")
    expect(formatSemanticResults("q", [{ path: "a.ts", score: 1.5, preview: "x" }])).toContain("1 file(s)")
  })
})

describe("semantic_search tool", () => {
  it("rejects a missing query", async () => {
    const tool = createSemanticSearchTool()
    const res = await tool.execute("id", {}, undefined, undefined, undefined)
    expect(res.isError).toBe(true)
  })

  it("finds the most relevant file in a temp workspace", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-sem-"))
    fs.writeFileSync(path.join(root, "memory.ts"), "project memory store recall capture memory memory\n")
    fs.writeFileSync(path.join(root, "server.ts"), "http listen socket port server unrelated\n")
    const tool = createSemanticSearchTool()
    const res = await tool.execute("id", { query: "project memory recall", top_k: 5 }, undefined, undefined, {
      cwd: root,
    } as never)
    const text = res.content.find((c) => c.type === "text")
    const body = text && "text" in text ? text.text : ""
    expect(body).toContain("memory.ts")
    fs.rmSync(root, { recursive: true, force: true })
  }, 15000)

  it("respects glob filters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tray-sem-"))
    fs.writeFileSync(path.join(root, "notes.md"), "project memory recall capture\n")
    fs.writeFileSync(path.join(root, "app.ts"), "unrelated server socket\n")
    const tool = createSemanticSearchTool()
    const res = await tool.execute("id", { query: "memory recall", glob: "*.md", top_k: 5 }, undefined, undefined, {
      cwd: root,
    } as never)
    const text = res.content.find((c) => c.type === "text")
    expect(text && "text" in text ? text.text : "").toContain("notes.md")
    fs.rmSync(root, { recursive: true, force: true })
  }, 15000)
})

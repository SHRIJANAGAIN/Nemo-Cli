/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Protected-metadata enforcement across the generic file tools (Codex
 * parity): `.git` and `.trayambak` are readable but can never be created,
 * modified, or deleted through write_file / edit_file / notebook_edit — at
 * any depth and in any spelling — while segment look-alikes (`.github`,
 * `.gitkeep`, `.gitignore`) stay writable. Home credential stores are
 * covered separately in types.test.ts.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createWriteFileTool } from "./file-edit/write-file.js"
import { createEditFileTool } from "./file-edit/edit-file.js"
import { createReadFileTool } from "./file-edit/read-file.js"
import { createNotebookEditTool } from "./trayambak/notebook-edit.js"
import type { ToolContext } from "./types.js"

function tmpCtx(): { dir: string; ctx: ToolContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-meta-"))
  return { dir, ctx: { cwd: dir } as unknown as ToolContext }
}

function resultText(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n")
}

const writeFile = createWriteFileTool()
const editFile = createEditFileTool()
const readFile = createReadFileTool()
const notebookEdit = createNotebookEditTool()

describe("protected metadata write gate", () => {
  it("rejects write_file into .git without creating the directory", async () => {
    const { dir, ctx } = tmpCtx()
    const r = await writeFile.execute(
      "t",
      { path: ".git/hooks/pre-commit", content: "evil" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false)
  })

  it("rejects write_file into .trayambak without creating the directory", async () => {
    const { dir, ctx } = tmpCtx()
    const r = await writeFile.execute(
      "t",
      { path: ".trayambak/commands/evil.md", content: "evil" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it("rejects writes to nested repositories, not just the top-level one", async () => {
    // Codex only carves out the first component under a writable root; this
    // port is stricter so `vendor/lib/.git/hooks` is covered too.
    const { dir, ctx } = tmpCtx()
    const r = await writeFile.execute(
      "t",
      { path: "vendor/lib/.git/hooks/pre-commit", content: "evil" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.existsSync(path.join(dir, "vendor"))).toBe(false)
  })

  it("rejects case-variant spellings before the permission prompt", async () => {
    const { dir, ctx } = tmpCtx()
    const r = await writeFile.execute("t", { path: ".GIT/config", content: "evil" }, undefined, undefined, ctx)
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.existsSync(path.join(dir, ".GIT"))).toBe(false)
  })

  it("rejects edit_file on an existing protected file and leaves it intact", async () => {
    const { dir, ctx } = tmpCtx()
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n", "utf8")
    const r = await editFile.execute(
      "t",
      { path: ".git/config", old_string: "[core]", new_string: "[evil]" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.readFileSync(path.join(dir, ".git", "config"), "utf8")).toBe("[core]\n")
  })

  it("rejects notebook_edit on protected paths and leaves the notebook intact", async () => {
    const { dir, ctx } = tmpCtx()
    const nb = path.join(dir, ".trayambak", "nb.ipynb")
    fs.mkdirSync(path.dirname(nb), { recursive: true })
    const original = JSON.stringify({ cells: [{ cell_type: "code", id: "c1", source: [] }] })
    fs.writeFileSync(nb, original, "utf8")
    const r = await notebookEdit.execute(
      "t",
      { notebook_path: ".trayambak/nb.ipynb", cell_id: "c1", new_source: "x" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(resultText(r)).toContain("protected metadata")
    expect(fs.readFileSync(nb, "utf8")).toBe(original)
  })

  it("keeps segment look-alikes writable", async () => {
    const { dir, ctx } = tmpCtx()
    const r = await writeFile.execute(
      "t",
      { path: ".github/CODEOWNERS", content: "* @team\n" },
      undefined,
      undefined,
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(fs.readFileSync(path.join(dir, ".github", "CODEOWNERS"), "utf8")).toBe("* @team\n")
  })
})

describe("protected metadata read gate", () => {
  it("reads .git and .trayambak files — only writes are denied", async () => {
    const { dir, ctx } = tmpCtx()
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n", "utf8")
    fs.mkdirSync(path.join(dir, ".trayambak"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".trayambak", "config.json"), "{}", "utf8")

    const git = await readFile.execute("t", { path: ".git/config" }, undefined, undefined, ctx)
    expect(git.isError).toBeFalsy()
    expect(resultText(git)).toContain("[core]")

    const state = await readFile.execute("t", { path: ".trayambak/config.json" }, undefined, undefined, ctx)
    expect(state.isError).toBeFalsy()
    expect(resultText(state)).toContain("{}")
  })
})

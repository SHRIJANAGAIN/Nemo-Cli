/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * NotebookEdit contract: editing a cell is a content-preserving operation.
 * The nbformat `source` rule is that every line except the LAST carries a
 * trailing "\n" — writing one on the last line grows the cell on every edit.
 * A notebook whose JSON has no `cells` array is malformed input, not a crash.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createNotebookEditTool } from "./notebook-edit.js"
import type { ToolContext } from "../types.js"

const ctx = (cwd: string): ToolContext => ({ cwd }) as unknown as ToolContext

describe("nemo__NotebookEdit", () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-nb-"))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  function writeNotebook(dir: string, body: unknown): string {
    const file = path.join(dir, "book.ipynb")
    fs.writeFileSync(file, JSON.stringify(body), "utf8")
    return file
  }

  async function edit(
    dir: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const tool = createNotebookEditTool()
    const r = await tool.execute("t1", { notebook_path: path.join(dir, "book.ipynb"), ...args }, undefined, undefined, ctx(dir))
    return { isError: r.isError, text: r.content.map((p) => ("text" in p ? p.text : "")).join("") }
  }

  it("does not append a trailing newline to the last source line", async () => {
    const dir = tmp()
    writeNotebook(dir, {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: "c1", cell_type: "code", source: ["a\n", "b"] }],
    })
    const res = await edit(dir, { cell_id: "c1", new_source: "a\nb" })
    expect(res.isError).toBe(false)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "book.ipynb"), "utf8")) as {
      cells: Array<{ id: string; source: string[] }>
    }
    // Only the interior line break carries "\n"; the last line stays bare, so
    // "a\nb" round-trips as "a\nb" — the old code also wrote "b\n" (growth).
    expect(saved.cells[0]?.source).toEqual(["a\n", "b"])
  })

  it("keeps a single bare line bare", async () => {
    const dir = tmp()
    writeNotebook(dir, {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: "c1", cell_type: "markdown", source: ["x"] }],
    })
    const res = await edit(dir, { cell_id: "c1", new_source: "plain" })
    expect(res.isError).toBe(false)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "book.ipynb"), "utf8")) as {
      cells: Array<{ source: string[] }>
    }
    expect(saved.cells[0]?.source).toEqual(["plain"])
  })

  it("reports a missing 'cells' array as a tool error instead of crashing", async () => {
    const dir = tmp()
    writeNotebook(dir, { nbformat: 4, nbformat_minor: 5, metadata: {} })
    const res = await edit(dir, { cell_id: "c1", new_source: "x" })
    expect(res.isError).toBe(true)
    expect(res.text).toContain("Cell not found")
  })
})
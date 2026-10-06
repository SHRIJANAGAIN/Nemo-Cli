/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createRulesTool } from "./rules.js"
import type { ToolContext } from "../types.js"

/**
 * Regression: the `write` action used `path.join(targetDir, name)` with a
 * raw model-supplied `name`, so `..\..\AppData\...`-style values wrote
 * attacker-chosen bytes anywhere on disk (any extension, full content
 * control). The guard now refuses the segment before fs is touched.
 */
describe("trayambak__Rules write containment", () => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const created: string[] = []
  const tmpDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rules-${tag}-`))
    created.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of created.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  const outText = (res: unknown): string => {
    const r = res as { content: Array<{ type: string; text: string }>; isError: boolean }
    return r.content.map((c) => c.text).join("\n") + (r.isError ? " [isError]" : "")
  }

  it("refuses a traversal rule name and writes nothing", async () => {
    const cwd = tmpDir()
    const tool = createRulesTool()
    const evilName = `..\\..\\esc-${tag}.md`
    const res = await tool.execute("r1", { action: "write", name: evilName, content: "pwned" }, undefined, undefined, {
      cwd,
    } as ToolContext)
    expect(outText(res)).toContain("Invalid rule file name")
    expect(outText(res)).toContain("[isError]")
    expect(fs.readdirSync(cwd)).toEqual([])
    expect(fs.existsSync(path.join(cwd, "..", "..", `esc-${tag}.md`))).toBe(false)
  })

  it("writes a plain rule file into the project directory", async () => {
    const cwd = tmpDir()
    const tool = createRulesTool()
    const name = `AGENTS-${tag}.md`
    const res = await tool.execute("r2", { action: "write", name, content: "hello rules" }, undefined, undefined, {
      cwd,
    } as ToolContext)
    expect(outText(res)).toContain("Rule written")
    expect(fs.readFileSync(path.join(cwd, name), "utf8")).toBe("hello rules")
  })

  it("read action only matches discovered rule files, never arbitrary paths", async () => {
    const cwd = tmpDir()
    const tool = createRulesTool()
    const res = await tool.execute("r3", { action: "read", name: `..\\..\\secrets-${tag}.md` }, undefined, undefined, {
      cwd,
    } as ToolContext)
    expect(outText(res)).toContain("No rule file")
    expect(outText(res)).toContain("[isError]")
  })

  it("refuses reserved store files in global scope before touching disk", async () => {
    // Segment validation allows bare `config.json` (no separators, no `..`),
    // but global scope targets the live home store: overwriting it with
    // model-chosen bytes redirects the next provider call (baseUrl) and
    // leaks the key. The refusal precedes mkdir/write, so this never touches
    // the real home directory.
    const cwd = tmpDir()
    const tool = createRulesTool()
    for (const reserved of ["config.json", "CONFIG.JSON", "config.json.bak", "sessions.json"]) {
      const res = await tool.execute(
        `r4-${reserved}`,
        { action: "write", name: reserved, scope: "global", content: `{"baseUrl":"https://evil-${tag}.example"}` },
        undefined,
        undefined,
        { cwd } as ToolContext,
      )
      expect(outText(res)).toContain("reserved")
      expect(outText(res)).toContain("[isError]")
    }
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it("still allows config.json as a project-scope rule name (not a loaded path)", async () => {
    // `<cwd>/config.json` is never read as config (only `<cwd>/.trayambak/`
    // or `~/.trayambak/config.json` are), so project scope stays unblocked.
    const cwd = tmpDir()
    const tool = createRulesTool()
    const res = await tool.execute(
      "r5",
      { action: "write", name: "config.json", content: "project notes" },
      undefined,
      undefined,
      { cwd } as ToolContext,
    )
    expect(outText(res)).toContain("Rule written")
    expect(fs.readFileSync(path.join(cwd, "config.json"), "utf8")).toBe("project notes")
  })
})

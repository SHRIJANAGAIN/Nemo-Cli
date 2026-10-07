/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGrepTool } from "./grep.js"
import { setRipgrepOverride } from "../search/ripgrep.js"
import type { ToolContext } from "../types.js"

describe("grep Node fallback truncation notice", () => {
  let dir = ""

  beforeEach(() => {
    setRipgrepOverride(null) // force the pure-Node fallback
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-grep-fb-"))
    fs.writeFileSync(path.join(dir, "a.txt"), "m\nm\nm\nm\nm\n", "utf8")
  })

  afterEach(() => {
    setRipgrepOverride(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("reports (more matches available) like the ripgrep path", async () => {
    // The rg path sets hasMore via `matchCount >= maxResults`; the fallback
    // computed `total > maxResults`, impossible because both loops break AT
    // the cap — so the model was told the search was complete when it wasn't.
    const res = await createGrepTool().execute(
      "t1",
      { pattern: "m", max_results: 2 },
      undefined,
      undefined,
      { cwd: dir } as unknown as ToolContext,
    )
    expect(JSON.stringify(res)).toContain("(more matches available)") // RED: "Found 2 match(es)" with no notice
  })
})
/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { installMarketplaceEntry, scanMarketplace } from "./marketplace.js"

let shelf = ""
let project = ""

afterEach(() => {
  for (const dir of [shelf, project]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
  shelf = ""
  project = ""
})

describe("marketplace agent name resolution", () => {
  it("installs the advertised frontmatter name even when the file name differs", () => {
    shelf = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-shelf2-"))
    fs.mkdirSync(path.join(shelf, "agents"), { recursive: true })
    // File base name ≠ frontmatter name. scanMarketplace advertises "reviewer"
    // (from frontmatter); install looked up agents/reviewer.md and failed.
    fs.writeFileSync(
      path.join(shelf, "agents", "my-reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nBody.\n",
      "utf8",
    )
    expect(scanMarketplace(shelf)).toContainEqual({ kind: "agent", name: "reviewer", description: "Reviews code" })

    project = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-proj2-"))
    const res = installMarketplaceEntry(shelf, "agent", "reviewer", project)
    expect(res.ok).toBe(true) // RED: ok:false — "Agent 'reviewer' is not on the shelf."
    expect(fs.existsSync(path.join(project, ".trayambak", "agents", "reviewer.md"))).toBe(true)
  })
})
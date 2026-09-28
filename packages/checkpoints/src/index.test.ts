/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createCheckpoint, listCheckpoints } from "./index.js"

describe("checkpoints", () => {
  it("creates + lists", () => {
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cp-sess-"))
    process.env.TRAYAMBAK_SESSIONS_DIR = sdir
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cp-work-"))
    fs.writeFileSync(path.join(work, "a.md"), "hi")
    const cp = createCheckpoint("sess1", work)
    expect(cp.id.startsWith("cp-")).toBe(true)
    expect(listCheckpoints("sess1").length).toBe(1)
  })
})

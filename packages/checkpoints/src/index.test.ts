/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createCheckpoint, listCheckpoints } from "./index.js"

describe("checkpoints", () => {
  it("creates + lists", () => {
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cp-sess-"))
    process.env.NEMO_SESSIONS_DIR = sdir
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cp-work-"))
    fs.writeFileSync(path.join(work, "a.md"), "hi")
    const cp = createCheckpoint("sess1", work)
    expect(cp.id.startsWith("cp-")).toBe(true)
    expect(listCheckpoints("sess1").length).toBe(1)
  })
})

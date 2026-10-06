/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import { checkpointCommand } from "./checkpoint.js"

/**
 * Usage contract: printing usage text with exit 0 reads as success to every
 * script driving the CLI, so usage errors exit 2 like the rest of the tree.
 */
describe("checkpointCommand usage", () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  it("exits 2 with no args", () => {
    expect(checkpointCommand([])).toBe("Usage: trayambak checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })

  it("exits 2 on an unknown action", () => {
    expect(checkpointCommand(["frobnicate", "s1"])).toBe("Usage: trayambak checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })

  it("exits 2 when the session id is missing", () => {
    expect(checkpointCommand(["create"])).toBe("Usage: trayambak checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
    expect(checkpointCommand(["list"])).toBe("Usage: trayambak checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })
})

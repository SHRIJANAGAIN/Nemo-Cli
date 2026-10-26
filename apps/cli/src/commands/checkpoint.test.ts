/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
    expect(checkpointCommand([])).toBe("Usage: nemo checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })

  it("exits 2 on an unknown action", () => {
    expect(checkpointCommand(["frobnicate", "s1"])).toBe("Usage: nemo checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })

  it("exits 2 when the session id is missing", () => {
    expect(checkpointCommand(["create"])).toBe("Usage: nemo checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
    expect(checkpointCommand(["list"])).toBe("Usage: nemo checkpoint <create|list> <session-id>")
    expect(process.exitCode).toBe(2)
  })
})

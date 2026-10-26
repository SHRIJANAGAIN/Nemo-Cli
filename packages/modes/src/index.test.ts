/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_MODES, getModeBySlug, loadRoomodes } from "./index.js"

describe("modes", () => {
  it("has 5 built-ins", () => {
    expect(DEFAULT_MODES.map((m) => m.slug).sort()).toEqual(["architect", "ask", "code", "debug", "orchestrator"])
  })
  it("custom overrides built-in", () => {
    const custom = [
      {
        slug: "code",
        name: "Mine",
        roleDefinition: "x",
        groups: ["read"] as Array<"read" | "edit" | "command" | "mcp" | "modes">,
      },
    ]
    expect(getModeBySlug("code", custom)?.name).toBe("Mine")
  })
  it("missing file returns []", () => {
    expect(loadRoomodes("/definitely/not/here")).toEqual([])
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
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

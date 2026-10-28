/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { isEnabled, listFlags, STABLE_FEATURES } from "./feature_flags.js"

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("FEATURE_")) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }
})

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("FEATURE_")) delete process.env[k]
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v
  }
})

describe("feature_flags", () => {
  it("returns stable defaults", () => {
    expect(isEnabled("streamingGate")).toBe(STABLE_FEATURES["streamingGate"])
    expect(isEnabled("unknown_flag_xyz")).toBe(false)
  })

  it("env override wins both ways", () => {
    process.env.FEATURE_SANDBOXSPAWN = "1"
    expect(isEnabled("sandboxSpawn")).toBe(true)
    process.env.FEATURE_STREAMINGGATE = "off"
    expect(isEnabled("streamingGate")).toBe(false)
  })

  it("ignores unparseable values", () => {
    process.env.FEATURE_SANDBOXSPAWN = "maybe"
    expect(isEnabled("sandboxSpawn")).toBe(STABLE_FEATURES["sandboxSpawn"])
  })

  it("lists known flags", () => {
    expect(Object.keys(listFlags()).sort()).toEqual(Object.keys(STABLE_FEATURES).sort())
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import { TrayambakClient } from "./index.js"

describe("sdk", () => {
  it("constructs", () => {
    expect(new TrayambakClient()).toBeDefined()
  })
})

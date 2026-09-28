/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import { dispatchMcpServer } from "./index.js"

describe("mcp-server dispatch", () => {
  it("handles tools/list without throwing", async () => {
    await expect(dispatchMcpServer({ method: "tools/list" })).resolves.toBeUndefined()
  })
})

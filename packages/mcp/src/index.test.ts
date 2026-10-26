/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { mcpChildEnv } from "./index.js"

/**
 * MCP child-environment contract (#62): spawned stdio servers receive the
 * filtered process env (secret families stripped — the same deny-list as
 * hook-exec / mcp-runner / MCP-server bash) with `spec.env` layered on top.
 * Before this, spawn handed the FULL process env — provider API keys
 * included — to every configured server.
 */
describe("mcpChildEnv", () => {
  it("strips secret-bearing process vars but keeps ordinary env and spec.env (#62)", () => {
    process.env.NEMO_MCP_ENV_KEEP = "visible-thing"
    process.env.NEMO_MCP_ENV_SECRET = "leaked-credential"
    try {
      const env = mcpChildEnv({ env: { SPEC_DECLARED: "1" } })
      expect(env.NEMO_MCP_ENV_KEEP).toBe("visible-thing")
      expect(env.NEMO_MCP_ENV_SECRET).toBeUndefined()
      expect(env.SPEC_DECLARED).toBe("1")
      // Shells and toolchains still resolve in the child (Path casing varies
      // per platform; neither name matches a blocked pattern).
      expect(env.PATH ?? env.Path).toBeDefined()
    } finally {
      delete process.env.NEMO_MCP_ENV_KEEP
      delete process.env.NEMO_MCP_ENV_SECRET
    }
  })

  it("lets spec.env re-declare a name the base filter strips (config wins)", () => {
    process.env.NEMO_MCP_TOKEN_X = "from-process"
    try {
      const env = mcpChildEnv({ env: { NEMO_MCP_TOKEN_X: "from-spec" } })
      expect(env.NEMO_MCP_TOKEN_X).toBe("from-spec")
    } finally {
      delete process.env.NEMO_MCP_TOKEN_X
    }
  })
})

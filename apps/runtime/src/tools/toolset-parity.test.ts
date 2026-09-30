/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { TOOLSET_DEFS, createDefaultTools } from "./index.js"

/**
 * Toolset parity, both directions:
 *  - every registered tool must appear in at least one toolset, or
 *    Arsenal.resolveTools silently strips it before it reaches the model
 *    (trayambak__AgentCatalog shipped this way: advertised in the system
 *    prompt, unreachable in practice → "Unknown tool");
 *  - every toolset entry must name a registered tool (the inverse case the
 *    TOOLSET_DEFS comment already warns about).
 */
describe("toolset parity", () => {
  it("every registered tool belongs to at least one toolset", () => {
    const { tools } = createDefaultTools()
    const names = tools.map((t) => t.definition.name)
    const inSets = new Set(TOOLSET_DEFS.flatMap((d) => d.toolNames))
    // Dynamic families are resolved at runtime, not via static toolsets.
    const dynamic = (n: string): boolean => n.startsWith("mcp__") || n.startsWith("skill__")
    const orphaned = names.filter((n) => !inSets.has(n) && !dynamic(n))
    expect(orphaned).toEqual([])
  })

  it("every toolset entry names a registered tool", () => {
    const { tools } = createDefaultTools()
    const registered = new Set(tools.map((t) => t.definition.name))
    const dangling: string[] = []
    for (const def of TOOLSET_DEFS) {
      for (const name of def.toolNames) {
        if (!registered.has(name)) dangling.push(`${def.name}:${name}`)
      }
    }
    expect(dangling).toEqual([])
  })

  it("trayambak__AgentCatalog survives arsenal filtering when config is present", async () => {
    // Regression: the tool was advertised in the system prompt but stripped
    // by resolveTools whenever a config existed → "Unknown tool" at call time.
    const { loadConfig } = await import("../config.js")
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, loadConfig({ cwd: process.cwd() }))
    expect(tools.map((t) => t.definition.name)).toContain("trayambak__AgentCatalog")
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { AGENT_TYPES, createAgentTool } from "./agent.js"

describe("trayambak__Agent subagent_type (company personas must pass)", () => {
  it("does not enum-lock subagent_type to the six builtins", () => {
    const tool = createAgentTool()
    expect(tool.definition.name).toBe("trayambak__Agent")
    const props = tool.definition.parameters as { properties: Record<string, { enum?: unknown; description?: string }> }
    // A provider-side enum would reject every company persona name (400 on
    // the whole turn) — the schema stays open, builtins listed in prose.
    expect(props.properties.subagent_type?.enum).toBeUndefined()
    expect(props.properties.subagent_type?.description).toContain("Code Reviewer")
    expect(props.properties.subagent_type?.description).toContain("trayambak__AgentCatalog")
    expect(AGENT_TYPES).toContain("general")
  })

  it("passes a company persona name through to the runner untouched", async () => {
    let seen: string | undefined
    const tool = createAgentTool(async (params) => {
      seen = params.subagentType
      return "ok"
    })
    const result = await tool.execute("id", { description: "d", prompt: "p", subagent_type: "Code Reviewer" }, undefined, undefined, undefined)
    expect(seen).toBe("Code Reviewer")
    expect(result.content.map((p) => ("text" in p ? p.text : "")).join("")).toContain("ok")
  })
})

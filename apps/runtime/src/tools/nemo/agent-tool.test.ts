/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { AGENT_TYPES, createAgentTool } from "./agent.js"

describe("nemo__Agent subagent_type (company personas must pass)", () => {
  it("does not enum-lock subagent_type to the six builtins", () => {
    const tool = createAgentTool()
    expect(tool.definition.name).toBe("nemo__Agent")
    const props = tool.definition.parameters as { properties: Record<string, { enum?: unknown; description?: string }> }
    // A provider-side enum would reject every company persona name (400 on
    // the whole turn) — the schema stays open, builtins listed in prose.
    expect(props.properties.subagent_type?.enum).toBeUndefined()
    expect(props.properties.subagent_type?.description).toContain("Code Reviewer")
    expect(props.properties.subagent_type?.description).toContain("nemo__AgentCatalog")
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

  it("does not force a throwaway worktree when no isolation is requested", async () => {
    // The engine's own default is "inherit" (agent.ts: `task.isolation ??
    // "inherit"`) — ordinary subagents edit the SHARED working tree. The tool
    // used to default `?? "worktree"`, so every bare subagent request ran in
    // a git worktree that was removed in `finally` — all its file edits
    // silently vanished from the parent's tree.
    let seen: string | undefined = "unset"
    const tool = createAgentTool(async (params) => {
      seen = params.isolation
      return "ok"
    })
    const result = await tool.execute("id", { description: "d", prompt: "p" }, undefined, undefined, undefined)
    expect(seen).toBeUndefined()
    expect(result.content.map((p) => ("text" in p ? p.text : "")).join("")).toContain("ok")
  })
})

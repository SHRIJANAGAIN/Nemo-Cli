/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest"
import {
  subagentCardId,
  createSubagentCard,
  finalizeSubagentCard,
  applyChildToolEvent,
  buildSubagentRows,
  mergeAgentOptions,
  BUILTIN_AGENT_OPTIONS,
  type SubagentRouting,
} from "./subagent-view.js"
import type { TrayambakMessage, BackgroundSubagentState } from "./types.js"
import type { TaggedAgentEvent } from "../../../protocol/src/index.js"

const baseStart = {
  subagentId: "abc-123",
  name: "Refactor auth module",
  prompt: "Look through\n the auth module",
  subagentType: "explore",
  isolation: "isolated",
  background: false,
}

describe("subagentCardId", () => {
  it("prefixes foreground and background cards differently", () => {
    expect(subagentCardId("x", false)).toBe("subagent-x")
    expect(subagentCardId("x", true)).toBe("subagent-bg-x")
  })
})

describe("createSubagentCard", () => {
  it("builds a running system card with a SKT AI LABS-format title", () => {
    const card = createSubagentCard(baseStart, 1000)
    expect(card.id).toBe("subagent-abc-123")
    expect(card.role).toBe("system")
    expect(card.timestamp).toBe(1000)
    expect(card.isError).toBeUndefined()
    expect(card.subagentId).toBe("abc-123")
    expect(card.subagentName).toBe("Refactor auth module")
    expect(card.subagentType).toBe("explore")
    expect(card.subagentIsolation).toBe("isolated")
    expect(card.subagentBackground).toBe(false)
    expect(card.subagentState).toBe("running")
    expect(card.subagentToolCalls).toBe(0)
    expect(card.subagentPrompt).toBe(baseStart.prompt)
    // prompt whitespace is flattened in the visible title
    expect(card.content).toBe("explore Task — Look through the auth module")
  })

  it("marks background cards in both id and title", () => {
    const card = createSubagentCard({ ...baseStart, background: true }, 5)
    expect(card.id).toBe("subagent-bg-abc-123")
    expect(card.subagentBackground).toBe(true)
    expect(card.content).toBe("explore Task (background) — Look through the auth module")
  })

  it("caps long descriptions at 60 chars plus the ellipsis", () => {
    const card = createSubagentCard({ ...baseStart, prompt: `one\n${"x".repeat(200)}` }, 0)
    expect(card.content.endsWith("…")).toBe(true)
    const desc = card.content.split(" — ")[1] ?? ""
    expect(desc.length).toBe(61)
  })

  it("falls back for empty prompts and missing types", () => {
    const card = createSubagentCard({ ...baseStart, prompt: "   ", subagentType: undefined }, 0)
    expect(card.content).toBe("Agent Task — (no prompt)")
    expect(card.subagentType).toBeUndefined()
  })
})

describe("finalizeSubagentCard", () => {
  it("records completion without mutating the input card", () => {
    const card = createSubagentCard(baseStart, 1000)
    const done = finalizeSubagentCard(card, { state: "completed", detail: "done text" }, 4500)
    expect(done.subagentState).toBe("completed")
    expect(done.subagentDetail).toBe("done text")
    expect(done.subagentDurationMs).toBe(3500)
    expect(done.isError).toBe(false)
    // input untouched
    expect(card.subagentState).toBe("running")
    expect(card.subagentDetail).toBeUndefined()
    expect(card.subagentDurationMs).toBeUndefined()
  })

  it("clamps negative durations and flags failures", () => {
    const card = createSubagentCard(baseStart, 5000)
    const failed = finalizeSubagentCard(card, { state: "error", detail: "boom" }, 1000)
    expect(failed.subagentState).toBe("error")
    expect(failed.subagentDetail).toBe("boom")
    expect(failed.subagentDurationMs).toBe(0)
    expect(failed.isError).toBe(true)
  })
})

describe("applyChildToolEvent", () => {
  const routing: SubagentRouting = { messageId: "m1", background: false, toolCalls: 2 }

  const toolStart = (toolName: string): TaggedAgentEvent =>
    ({
      type: "tool_execution_start",
      toolName,
      subagentId: "abc-123",
      subagentName: "child",
    }) as unknown as TaggedAgentEvent

  it("counts tool starts and records the last tool", () => {
    const next = applyChildToolEvent(routing, toolStart("Write"))
    expect(next).not.toBeNull()
    expect(next?.toolCalls).toBe(3)
    expect(next?.lastTool).toBe("Write")
    expect(next?.messageId).toBe("m1")
    expect(next?.background).toBe(false)
  })

  it("returns null for non-tool events — the parent transcript stays protected", () => {
    const turnEnd = {
      type: "turn_end",
      subagentId: "abc-123",
    } as unknown as TaggedAgentEvent
    expect(applyChildToolEvent(routing, turnEnd)).toBeNull()
    const textDelta = {
      type: "text_delta",
      delta: "hi",
      subagentId: "abc-123",
    } as unknown as TaggedAgentEvent
    expect(applyChildToolEvent(routing, textDelta)).toBeNull()
  })

  it("does not mutate the input routing entry", () => {
    const before = { ...routing }
    applyChildToolEvent(routing, toolStart("Bash"))
    expect(routing).toEqual(before)
  })
})

describe("buildSubagentRows", () => {
  const card = (over: Partial<TrayambakMessage>): TrayambakMessage => ({
    id: "id",
    timestamp: 0,
    role: "system",
    content: "Title",
    isError: false,
    ...over,
  })

  it("maps foreground cards with prompt, detail and toolcall counts", () => {
    const rows = buildSubagentRows(
      [
        card({
          subagentId: "fg1",
          content: "explore Task — search the repo",
          subagentState: "completed",
          subagentDetail: "found it",
          subagentToolCalls: 7,
          subagentLastTool: "Grep",
          subagentPrompt: "search the repo",
          subagentType: "explore",
          subagentIsolation: "worktree",
          timestamp: 1_000,
          subagentDurationMs: 2_500,
        }),
      ],
      [],
      9_999,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: "fg1",
      source: "foreground",
      title: "explore Task — search the repo",
      status: "completed",
      prompt: "search the repo",
      detail: "found it",
      toolCalls: 7,
      lastTool: "Grep",
      isolation: "worktree",
      subagentType: "explore",
      startedAt: 1_000,
      durationMs: 2_500,
    })
  })

  it("routes foreground errors into the error field", () => {
    const rows = buildSubagentRows(
      [
        card({
          subagentId: "fg-err",
          subagentState: "error",
          subagentDetail: "model exploded",
          timestamp: 10,
        }),
      ],
      [],
      100,
    )
    expect(rows[0]?.status).toBe("error")
    expect(rows[0]?.error).toBe("model exploded")
    expect(rows[0]?.detail).toBeUndefined()
    expect(rows[0]?.durationMs).toBe(90) // computed from timestamp when not stored
  })

  it("excludes background cards — the job map is the source of truth", () => {
    const rows = buildSubagentRows(
      [card({ subagentId: "bg1", subagentBackground: true, subagentState: "running" })],
      [],
      500,
    )
    expect(rows).toHaveLength(0)
  })

  it("maps background jobs with live toolcalls and durations", () => {
    const jobs: BackgroundSubagentState[] = [
      {
        id: "j1",
        name: "Nightly audit",
        prompt: "audit token reuse",
        status: "running",
        startedAt: 100,
        toolcalls: 3,
        isolation: "isolated",
        subagentType: "explore",
      },
      {
        id: "j2",
        name: "Doc writer",
        prompt: "write docs",
        status: "completed",
        startedAt: 100,
        completedAt: 400,
        result: "wrote 2 files",
      },
    ]
    const rows = buildSubagentRows([], jobs, 1_000)
    expect(rows).toHaveLength(2)
    const running = rows.find((r) => r.id === "j1")
    expect(running?.source).toBe("background")
    expect(running?.toolCalls).toBe(3)
    expect(running?.durationMs).toBe(900) // now - startedAt
    expect(running?.isolation).toBe("isolated")
    expect(running?.subagentType).toBe("explore")
    const done = rows.find((r) => r.id === "j2")
    expect(done?.detail).toBe("wrote 2 files")
    expect(done?.durationMs).toBe(300) // completedAt - startedAt
  })

  it("sorts running first, then errors, then cancelled, then finished (newest first inside a band)", () => {
    const rows = buildSubagentRows(
      [
        card({ subagentId: "old-completed", subagentState: "completed", timestamp: 10 }),
        card({ subagentId: "new-completed", subagentState: "completed", timestamp: 50 }),
        card({ subagentId: "fg-running", subagentState: "running", timestamp: 20 }),
        card({ subagentId: "fg-error", subagentState: "error", timestamp: 30 }),
      ],
      [
        { id: "bg-running", name: "n", prompt: "p", status: "running", startedAt: 60 },
        { id: "bg-cancelled", name: "n", prompt: "p", status: "cancelled", startedAt: 70 },
      ],
      100,
    )
    expect(rows.map((r) => r.status)).toEqual(["running", "running", "error", "cancelled", "completed", "completed"])
    expect(rows.filter((r) => r.status === "running").map((r) => r.id)).toEqual(["bg-running", "fg-running"])
    expect(rows.filter((r) => r.status === "completed").map((r) => r.id)).toEqual(["new-completed", "old-completed"])
  })
})

describe("mergeAgentOptions", () => {
  it("keeps builtins first and appends custom profiles by name", () => {
    const merged = mergeAgentOptions([
      {
        id: "/path/to/security.audit.md",
        name: "security-audit",
        category: "security",
        description: "Audits for vulns",
      },
    ])
    expect(merged.slice(0, BUILTIN_AGENT_OPTIONS.length)).toEqual(BUILTIN_AGENT_OPTIONS)
    const custom = merged[BUILTIN_AGENT_OPTIONS.length]
    expect(custom?.value).toBe("security-audit") // value = NAME (getAgentProfile resolves by name)
    expect(custom?.label).toBe("security-audit")
    expect(custom?.category).toBe("security")
    expect(custom?.builtin).toBe(false)
  })

  it("replaces a builtin on case-insensitive name collision instead of duplicating", () => {
    const merged = mergeAgentOptions([
      { id: "/agents/EXPLORE.md", name: "EXPLORE", category: "custom", description: "My explore" },
    ])
    const explores = merged.filter((o) => o.value.toLowerCase() === "explore")
    expect(explores).toHaveLength(1)
    expect(explores[0]?.builtin).toBe(false)
    expect(explores[0]?.value).toBe("EXPLORE")
    expect(merged).toHaveLength(BUILTIN_AGENT_OPTIONS.length)
  })

  it("deduplicates repeated profiles", () => {
    const merged = mergeAgentOptions([
      { id: "a.md", name: "helper", category: "util", description: "one" },
      { id: "b.md", name: "Helper", category: "util", description: "two" },
    ])
    const helpers = merged.filter((o) => o.value.toLowerCase() === "helper")
    expect(helpers).toHaveLength(1)
    expect(helpers[0]?.description).toBe("two") // last one wins
  })

  it("fills in a description fallback when the profile has none", () => {
    const merged = mergeAgentOptions([{ id: "/agents/empty.md", name: "empty", category: "misc", description: "" }])
    expect(merged.find((o) => o.value === "empty")?.description).toBe("Custom agent profile (/agents/empty.md)")
  })
})

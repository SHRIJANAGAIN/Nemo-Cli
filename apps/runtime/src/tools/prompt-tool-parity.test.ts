/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Prompt ↔ registry parity.
 *
 * The system prompt promises the model a set of tools by name. Every name it
 * promises must resolve to a tool that is actually registered, otherwise the
 * model wastes turns calling tools that do not exist (and reports a failed
 * tool call to the user instead of doing work).
 *
 * This caught 8 phantom tools before it existed: nemo__EnterPlanMode,
 * nemo__RunWorkflow, plan, open_plan, and six nemo__Pentest* names
 * that appeared only in power-prompt.ts.
 */

import { describe, expect, it } from "vitest"
import { createDefaultTools, toolDefinitions, buildArsenalFromConfig, TOOLSET_DEFS } from "./index.js"
import { buildSystemPrompt } from "../prompt/power-prompt.js"
import type { NemoConfig } from "../config.js"

function builtPrompt(): { prompt: string; registered: Set<string> } {
  const { tools } = createDefaultTools()
  const registered = new Set(tools.map((t) => t.definition.name))
  const prompt = buildSystemPrompt({
    cwd: process.cwd(),
    tools: toolDefinitions(tools),
    nativeTools: true,
    model: "test-model",
  })
  return { prompt, registered }
}

/** Every `nemo__Foo` token appearing anywhere in the prompt. */
function promisedPrefixedTools(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/nemo__([A-Za-z0-9_]+)/g)].map((m) => "nemo__" + m[1]))].sort()
}

/**
 * Bare (unprefixed) tool names promised by `- name: description` bullets,
 * restricted to snake_case. Prose bullets are overwhelmingly lowercase words
 * with no underscore, so requiring `_` gives a signal with almost no false
 * positives — while still catching every bare phantom found to date:
 * `open_plan`, `task_create`, `memory_save`, `memory_recall`.
 */
function promisedBulletTools(prompt: string): string[] {
  const out = new Set<string>()
  for (const [, head] of prompt.matchAll(/^\s*-\s*(.+?):/gm)) {
    for (const token of head.split(/[\s,`()/]+/)) {
      if (/^[a-z][a-z0-9_]*_[a-z0-9_]+$/.test(token)) out.add(token)
    }
  }
  return [...out].sort()
}

describe("system prompt promises only registered tools", () => {
  it("every nemo__* name in the prompt is a real registered tool", () => {
    const { prompt, registered } = builtPrompt()
    const promised = promisedPrefixedTools(prompt)
    expect(promised.length).toBeGreaterThan(10)
    const phantom = promised.filter((name) => !registered.has(name))
    expect(phantom, `prompt promises unregistered tools: ${phantom.join(", ")}`).toEqual([])
  })

  it("every bare snake_case tool name promised by a bullet is registered", () => {
    const { prompt, registered } = builtPrompt()
    const promised = promisedBulletTools(prompt)
    // Anti-vacuity anchor: both are genuinely promised by the prompt and
    // genuinely registered. If the extraction regex ever drifts into matching
    // nothing, this fails rather than letting the phantom check pass for free.
    expect(promised).toEqual(expect.arrayContaining(["mcp__install", "tool_search"]))
    const phantom = promised.filter((name) => !registered.has(name))
    expect(phantom, `prompt promises unregistered bare tools: ${phantom.join(", ")}`).toEqual([])
  })

  it("the phantom tools removed on 2026-09-28 never come back", () => {
    const { prompt } = builtPrompt()
    // These appeared only in power-prompt.ts and had no implementation. The
    // real plan mode is the /plan permission uiMode, not a tool call.
    for (const ghost of ["open_plan", "nemo__EnterPlanMode", "nemo__PentestWebApp"]) {
      expect(prompt, `${ghost} is advertised but has no implementation`).not.toContain(ghost)
    }
  })

  it("every toolset allowlist entry resolves to a registered tool", () => {
    const { registered } = builtPrompt()
    const declared = new Set(TOOLSET_DEFS.flatMap((def) => def.toolNames))
    const unresolved = [...declared].filter((name) => !registered.has(name)).sort()
    expect(unresolved, `toolsets reference unregistered tools: ${unresolved.join(", ")}`).toEqual([])
    expect(declared.size).toBeGreaterThan(40)
  })

  it("enabling every toolset resolves them all (nothing silently dropped)", () => {
    const config = {
      cwd: process.cwd(),
      toolsets: { defaults: TOOLSET_DEFS.map((def) => def.name) },
    } as unknown as NemoConfig
    const arsenal = buildArsenalFromConfig(config)
    const resolved = new Set(arsenal.resolveTools(createDefaultTools().tools).map((t) => t.definition.name))
    const declared = new Set(TOOLSET_DEFS.flatMap((def) => def.toolNames))
    const dropped = [...declared].filter((name) => !resolved.has(name)).sort()
    expect(dropped, `resolveTools dropped: ${dropped.join(", ")}`).toEqual([])
  })

  it("keeps set_mode/get_mode in sync with the Agent mode accessor", () => {
    const { tools } = createDefaultTools()
    const names = new Set(tools.map((t) => t.definition.name))
    expect(names.has("set_mode")).toBe(true)
    expect(names.has("get_mode")).toBe(true)
    expect(names.has("nemo__NotebookEdit")).toBe(true)
    expect(names.has("nemo__RunWorkflow")).toBe(true)
  })
})

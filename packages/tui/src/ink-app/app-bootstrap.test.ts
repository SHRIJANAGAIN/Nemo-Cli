/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, test } from "vitest"

import { convertToAgentMessages, createAgentConfig } from "./app-bootstrap.js"
import type { TrayambakMessage } from "./types.js"

/**
 * app-bootstrap is the state-free half of App.tsx. These tests pin the two
 * behavioral contracts that have regressed before in live use:
 *  - createAgentConfig: optional fields must PASS THROUGH (dropping
 *    `provider` silently rebuilt every agent as NVIDIA → HF logins 401'd;
 *    dropping `developerMode` reset /devmode on every restart).
 *  - convertToAgentMessages: history rebuilds must keep tool context
 *    (toolCall + result rows) and thinking parts across turns.
 */
describe("createAgentConfig passthrough", () => {
  test("provider survives the rebuild when present, is not forced when absent", () => {
    expect(createAgentConfig({ provider: "huggingface" }).provider).toBe("huggingface")
    expect(createAgentConfig({}).provider).toBeUndefined()
  })

  test("reasoningEffort / permissions / developerMode pass through unchanged", () => {
    const permissions = { allow: ["Bash(git *)"], ask: [], deny: [] } as never
    const developerMode = { enabled: true, gated: true } as never
    const cfg = createAgentConfig({ reasoningEffort: "high", permissions, developerMode })
    expect(cfg.reasoningEffort).toBe("high")
    expect(cfg.permissions).toBe(permissions)
    expect(cfg.developerMode).toBe(developerMode)
  })

  test("explicit overrides win over defaults", () => {
    const cfg = createAgentConfig({ model: "qwen3", baseUrl: "http://router:8000", maxTurns: 3 })
    expect(cfg.model).toBe("qwen3")
    expect(cfg.baseUrl).toBe("http://router:8000")
    expect(cfg.maxTurns).toBe(3)
  })

  test("toolsets: empty default list fills the stock set, a real set passes through", () => {
    const filled = createAgentConfig({})
    expect(filled.toolsets?.defaults?.length).toBeGreaterThan(0)
    expect(filled.toolsets?.disabled).toEqual([])

    const custom = { defaults: ["core"], disabled: ["ops"], platform: {} }
    expect(createAgentConfig({ toolsets: custom }).toolsets).toBe(custom)
  })
})

describe("convertToAgentMessages", () => {
  test("system and user rows map one-to-one", () => {
    const out = convertToAgentMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ] as TrayambakMessage[])
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ])
  })

  test("assistant tool row rebuilds the toolCall part and its tool result", () => {
    const out = convertToAgentMessages([
      {
        role: "assistant",
        content: '{"command":"ls"}',
        toolCallId: "call_1",
        toolName: "bash",
        result: "file.txt",
        isError: false,
      },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
      stopReason: "tool_use",
    })
    expect(out[1]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "file.txt" }],
      isError: false,
    })
  })

  test("assistant tool row WITHOUT a result keeps the call only (no phantom tool turn)", () => {
    const out = convertToAgentMessages([
      { role: "assistant", content: "{}", toolCallId: "c", toolName: "read" },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "tool_use" })
  })

  test("malformed / non-object tool args degrade to { value } instead of throwing", () => {
    const malformed = convertToAgentMessages([
      { role: "assistant", content: "not json {", toolCallId: "c", toolName: "t" },
    ] as TrayambakMessage[])
    const call = malformed[0]?.content
    expect(Array.isArray(call) && call[0] && typeof call[0] === "object" && "arguments" in call[0]).toBe(true)
    expect(Array.isArray(call) ? (call[0] as { arguments: unknown }).arguments : null).toEqual({
      value: "not json {",
    })

    const nonObject = convertToAgentMessages([
      { role: "assistant", content: "[1,2]", toolCallId: "c", toolName: "t" },
    ] as TrayambakMessage[])
    const call2 = nonObject[0]?.content
    expect(Array.isArray(call2) ? (call2[0] as { arguments: unknown }).arguments : null).toEqual({
      value: [1, 2],
    })
  })

  test("thinking rides along ahead of the text part", () => {
    const out = convertToAgentMessages([
      { role: "assistant", content: "answer", thinking: "hmm…" },
    ] as TrayambakMessage[])
    expect(out[0]?.content).toEqual([
      { type: "thinking", text: "hmm…" },
      { type: "text", text: "answer" },
    ])
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "end_turn" })
  })

  test("tool rows without both ids are dropped; identified tool rows pass through", () => {
    const out = convertToAgentMessages([
      { role: "tool", content: "orphan" },
      { role: "tool", content: "ok", toolCallId: "t1", toolName: "read", isError: true },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      role: "tool",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: true,
    })
  })
})

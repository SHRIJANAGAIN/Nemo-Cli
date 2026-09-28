/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as os from "node:os"
import { runPreToolUseHooks, runPostToolUseHooks, type HookShellExecutor } from "./hook-exec.js"
import { runAgentLoop } from "../agent/agent-loop.js"
import { Session } from "../session/session.js"
import { textResult } from "./types.js"
import type { TrayambakConfig } from "../config.js"
import type { AgentMessage } from "../../../../packages/protocol/src/index.js"

function stubExecutor(handler: (command: string) => { stdout: string; exitCode?: number }): HookShellExecutor {
  const seen: string[] = []
  const exec: HookShellExecutor = {
    run: async ({ command }) => {
      seen.push(command)
      const out = handler(command)
      return {
        exitCode: out.exitCode ?? 0,
        stdout: { text: out.stdout },
        stderr: { text: "" },
      }
    },
  }
  ;(exec as unknown as { seen: string[] }).seen = seen
  return exec
}

const seenOf = (e: HookShellExecutor): string[] => (e as unknown as { seen: string[] }).seen

function cfgWith(hooks: TrayambakConfig["hooks"]): TrayambakConfig {
  return { hooks, cwd: process.cwd() } as TrayambakConfig
}

describe("runPreToolUseHooks", () => {
  it("passes through when no hooks match", async () => {
    const exec = stubExecutor(() => ({ stdout: "{}" }))
    const verdict = await runPreToolUseHooks(
      cfgWith({ preToolUse: [{ matcher: "bash", hooks: [{ command: "echo hi" }] }] }),
      { toolName: "read", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.ran).toBe(false)
    expect(verdict.decision).toBe("none")
    expect(seenOf(exec)).toEqual([])
  })

  it("blocks on deny with the hook reason", async () => {
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "nope",
        },
      }),
    }))
    const verdict = await runPreToolUseHooks(
      cfgWith({ preToolUse: [{ hooks: [{ command: "check.sh" }] }] }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.ran).toBe(true)
    expect(verdict.decision).toBe("deny")
    expect(verdict.reason).toContain("nope")
    expect(seenOf(exec)).toEqual(["check.sh"])
  })

  it("surfaces ask for the approval path", async () => {
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "confirm?",
        },
      }),
    }))
    const verdict = await runPreToolUseHooks(
      cfgWith({ preToolUse: [{ matcher: "write", hooks: [{ command: "gate.sh" }] }] }),
      { toolName: "write_file", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.decision).toBe("ask")
    expect(verdict.reason).toContain("confirm?")
  })

  it("accumulates additionalContext in hook order", async () => {
    const exec = stubExecutor((cmd) => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `ctx-from-${cmd}` },
      }),
    }))
    const verdict = await runPreToolUseHooks(
      cfgWith({
        preToolUse: [{ hooks: [{ command: "a.sh" }, { command: "b.sh" }] }],
      }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.decision).toBe("none")
    expect(verdict.additionalContext).toEqual(["ctx-from-a.sh", "ctx-from-b.sh"])
  })

  it("treats invalid matcher regex as non-match, never throws", async () => {
    const exec = stubExecutor(() => ({ stdout: "{}" }))
    const verdict = await runPreToolUseHooks(
      cfgWith({ preToolUse: [{ matcher: "([invalid", hooks: [{ command: "x.sh" }] }] }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.ran).toBe(false)
    expect(seenOf(exec)).toEqual([])
  })
})

describe("runPostToolUseHooks", () => {
  it("returns context and never blocks", async () => {
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "late",
          additionalContext: "note",
        },
      }),
    }))
    const ctx = await runPostToolUseHooks(
      cfgWith({ postToolUse: [{ hooks: [{ command: "audit.sh" }] }] }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(ctx).toEqual(["note"])
  })

  it("returns empty when nothing matches", async () => {
    const exec = stubExecutor(() => ({ stdout: "{}" }))
    const ctx = await runPostToolUseHooks(
      cfgWith({ postToolUse: [{ matcher: "zzz", hooks: [{ command: "a.sh" }] }] }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(ctx).toEqual([])
    expect(seenOf(exec)).toEqual([])
  })
})

describe("agent loop hook wiring", () => {
  const loopCfg = {
    maxTurns: 5,
    maxRetries: 0,
    retryDelayMs: 50,
    maxToolCalls: 5,
    maxParallelToolCalls: 4,
    toolCallRate: 0,
    maxDistinctToolCalls: 1000,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: true },
  } as unknown as TrayambakConfig

  function loopHarness(executor: HookShellExecutor, hooks: TrayambakConfig["hooks"]) {
    let ran = false
    const tool = {
      definition: {
        timeoutMs: 30_000,
        name: "bash",
        description: "run",
        parameters: { type: "object", properties: {}, required: [] },
      },
      execute: async () => {
        ran = true
        return textResult("did-it")
      },
    }
    const provider = {
      chat: async () => ({
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
        stopReason: "tool_use",
      }),
    } as never
    return {
      ran: () => ran,
      run: (maxTurns: number) =>
        runAgentLoop("do it", {
          provider,
          tools: [tool as never],
          session: new Session(),
          config: { ...loopCfg, maxTurns, hooks },
          emit: async () => {},
          onRequestPermission: async () => true,
          hookExecutor: executor,
        }),
    }
  }

  it("denies execution when a PreToolUse hook blocks", async () => {
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "nope",
        },
      }),
    }))
    const h = loopHarness(exec, { preToolUse: [{ hooks: [{ command: "gate.sh" }] }] })
    const messages = await h.run(3)
    expect(h.ran()).toBe(false)
    const toolMsg = messages.filter((m: AgentMessage) => m.role === "tool").pop() as {
      content: Array<{ text: string }>
    }
    expect(toolMsg.content.map((c) => c.text).join("\n")).toContain("Hook blocked bash: nope")
  }, 15000)

  it("appends hook context to the tool result", async () => {
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "remember-this" },
      }),
    }))
    const h = loopHarness(exec, { postToolUse: [{ hooks: [{ command: "note.sh" }] }] })
    const messages = await h.run(3)
    expect(h.ran()).toBe(true)
    const toolMsg = messages.filter((m: AgentMessage) => m.role === "tool").pop() as {
      content: Array<{ text: string }>
    }
    const text = toolMsg.content.map((c) => c.text).join("\n")
    expect(text).toContain("did-it")
    expect(text).toContain("remember-this")
  }, 15000)
})

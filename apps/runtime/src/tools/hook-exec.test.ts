/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as os from "node:os"
import {
  execHookShell,
  hookChildEnv,
  runPreToolUseHooks,
  runPostToolUseHooks,
  type HookShellExecutor,
} from "./hook-exec.js"
import {
  getHookRuntime,
  HOOK_HISTORY_LIMIT,
  HookEventName,
  HookExecutionMode,
} from "../../../../packages/core/src/hook_runtime.js"
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

// Integration coverage for the programmatic HookRuntime layer wired into
// hook-exec (AGENTS.md: hook_runtime.ts changes require integration tests).
describe("programmatic HookRuntime layer", () => {
  it("a registered PreToolUse hook denies without any config hooks", async () => {
    const runtime = getHookRuntime()
    runtime.clear()
    runtime.register({
      name: "deny-bash",
      events: [HookEventName.PreToolUse],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 1000,
      handler: async (ctx) =>
        ctx.toolName === "bash"
          ? { shouldStop: true, additionalContext: ["blocked by programmatic hook"] }
          : { shouldStop: false, additionalContext: [] },
    })
    const exec = stubExecutor(() => ({ stdout: "{}" }))
    const verdict = await runPreToolUseHooks(
      cfgWith(undefined),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(verdict.decision).toBe("deny")
    expect(verdict.stop).toBe(true)
    expect(verdict.additionalContext).toEqual(["blocked by programmatic hook"])
    // Fast-fail: a programmatic deny must not spawn shell hook subprocesses.
    expect(seenOf(exec)).toEqual([])
  })

  it("programmatic PostToolUse observers append context after shell hooks", async () => {
    const runtime = getHookRuntime()
    runtime.clear()
    runtime.register({
      name: "observer",
      events: [HookEventName.PostToolUse],
      mode: HookExecutionMode.NonBlocking,
      timeoutMs: 1000,
      handler: async () => ({ shouldStop: false, additionalContext: ["runtime-observed"] }),
    })
    const exec = stubExecutor(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "shell-note" },
      }),
    }))
    const ctx = await runPostToolUseHooks(
      cfgWith({ postToolUse: [{ hooks: [{ command: "note.sh" }] }] }),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      exec,
    )
    expect(ctx).toEqual(["shell-note", "runtime-observed"])
  })

  it("records bounded history for every event that runs a hook", async () => {
    const runtime = getHookRuntime()
    runtime.clear()
    runtime.register({
      name: "counted",
      events: [HookEventName.PostToolUse],
      mode: HookExecutionMode.NonBlocking,
      timeoutMs: 1000,
      handler: async () => ({ shouldStop: false, additionalContext: [] }),
    })
    const input = { toolName: "bash", args: {}, cwd: process.cwd() }
    for (let i = 0; i < HOOK_HISTORY_LIMIT + 25; i += 1) {
      await runPostToolUseHooks(
        cfgWith(undefined),
        input,
        stubExecutor(() => ({ stdout: "{}" })),
      )
    }
    expect(runtime.getHistory().length).toBe(HOOK_HISTORY_LIMIT)
  })

  it("clear() starts fresh — defaults are not re-seeded behind the caller", async () => {
    const runtime = getHookRuntime()
    runtime.clear()
    const verdict = await runPreToolUseHooks(
      cfgWith(undefined),
      { toolName: "bash", args: {}, cwd: process.cwd() },
      stubExecutor(() => ({ stdout: "{}" })),
    )
    expect(verdict.ran).toBe(false)
    expect(verdict.decision).toBe("none")
    expect(runtime.getRegisteredHooks()).toEqual([])
  })
})

// P0#2 — secrets must be redacted BEFORE anything crosses into a hook. The
// stdin payload of a config shell hook and the context handed to a registered
// handler are the two egress points; both are covered here (integration,
// deterministic, zero network).
describe("hook payload redaction", () => {
  const longArg = "/home/someone/very/long/project/path/src/deeply/nested/index.ts"

  function stdinExecutor(): HookShellExecutor & { stdinSeen: string[] } {
    const stdinSeen: string[] = []
    return {
      stdinSeen,
      run: async ({ stdin }) => {
        stdinSeen.push(stdin)
        return { exitCode: 0, stdout: { text: "{}" }, stderr: { text: "" } }
      },
    }
  }

  it("a shell hook's stdin payload never contains raw secrets; long args arrive byte-for-byte", async () => {
    const exec = stdinExecutor()
    const args = {
      command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com/v1",
      apiKey: "sk-abcdefghijklmnop0123456789",
      content: "pushed with ghp_abcdefghij0123456789 yesterday",
      file_path: longArg,
    }
    const verdict = await runPreToolUseHooks(
      cfgWith({ preToolUse: [{ hooks: [{ command: "echo-payload.sh" }] }] }),
      { toolName: "bash", args, cwd: process.cwd() },
      exec,
    )
    expect(verdict.ran).toBe(true)
    expect(exec.stdinSeen).toHaveLength(1)
    const raw = exec.stdinSeen[0]
    expect(raw).not.toContain("abc.def.ghi")
    expect(raw).not.toContain("sk-abcdefghijklmnop0123456789")
    expect(raw).not.toContain("ghp_abcdefghij0123456789")
    const payload = JSON.parse(raw) as { tool_input: Record<string, unknown> }
    expect(payload.tool_input.apiKey).toBe("****")
    expect(String(payload.tool_input.command)).toContain("[REDACTED]")
    expect(payload.tool_input.content).toBe("pushed with [REDACTED] yesterday")
    expect(payload.tool_input.file_path).toBe(longArg)
    // Redaction copies — the caller's own args object is untouched.
    expect(args.apiKey).toBe("sk-abcdefghijklmnop0123456789")
    expect(args.content).toContain("ghp_abcdefghij0123456789")
  })

  it("a registered hook echoing its payload only ever sees redacted args", async () => {
    const runtime = getHookRuntime()
    runtime.clear()
    let echo = ""
    runtime.register({
      name: "echo-payload",
      events: [HookEventName.PreToolUse],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 1000,
      handler: async (ctx) => {
        echo = JSON.stringify(ctx.args ?? {})
        return { shouldStop: false, additionalContext: [`payload: ${echo}`] }
      },
    })
    const args = {
      command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com/v1",
      apiKey: "sk-abcdefghijklmnop0123456789",
      file_path: longArg,
    }
    const verdict = await runPreToolUseHooks(
      cfgWith(undefined),
      { toolName: "bash", args, cwd: process.cwd() },
      stubExecutor(() => ({ stdout: "{}" })),
    )
    expect(echo).not.toContain("abc.def.ghi")
    expect(echo).not.toContain("sk-abcdefghijklmnop0123456789")
    expect(echo).toContain("[REDACTED]")
    expect(echo).toContain(longArg)
    expect(verdict.additionalContext[0]).toContain("[REDACTED]")
    expect(verdict.additionalContext[0]).not.toContain("sk-abcdefghijklmnop0123456789")
    expect(verdict.additionalContext[0]).toContain(longArg)
  })
})

describe("hook child environment", () => {
  const seededKeys = ["TRAYAMBAK_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY"]
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const key of seededKeys) {
      saved[key] = process.env[key]
      process.env[key] = "sk-abcdef0123456789secretvalue"
    }
  })

  afterEach(() => {
    for (const key of seededKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key] as string
    }
  })

  it("strips credential-shaped vars but keeps PATH", () => {
    const env = hookChildEnv()
    expect(env.TRAYAMBAK_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NVIDIA_API_KEY).toBeUndefined()
    expect(env.PATH).toBeTruthy()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it("merges config-declared extras on top of the filtered env", () => {
    const env = hookChildEnv({ HOOK_MODE: "strict" })
    expect(env.HOOK_MODE).toBe("strict")
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it("a real hook child process does not inherit API keys but keeps PATH", async () => {
    const out = await execHookShell.run({
      command:
        'node -p "JSON.stringify({ trayambakKey: typeof process.env.TRAYAMBAK_API_KEY, openaiKey: typeof process.env.OPENAI_API_KEY, path: !!process.env.PATH })"',
      stdin: "",
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    })
    expect(out.exitCode).toBe(0)
    const parsed = JSON.parse(out.stdout.text.trim()) as {
      trayambakKey: string
      openaiKey: string
      path: boolean
    }
    expect(parsed.trayambakKey).toBe("undefined")
    expect(parsed.openaiKey).toBe("undefined")
    expect(parsed.path).toBe(true)
  }, 30_000)
})

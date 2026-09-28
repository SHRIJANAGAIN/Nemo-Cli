/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import type { HookShellExecutor, RunHookOptions } from "./runner.js"
import { runHook, DEFAULT_HOOK_TIMEOUT_MS, createDetachedRuns } from "./runner.js"
import { parseHookOutput } from "./codec.js"
import { mergeHookOutputs } from "./merge.js"
import { matchesMatcher, matcherDiagnostic } from "./matcher.js"
import { summarizeStderr, buildHookResult } from "./events.js"

interface ShellRunResult {
  exitCode: number | null
  stdout: { text: string }
  stderr: { text: string }
}

function recordingBash(run: (spec: Record<string, unknown>) => Promise<ShellRunResult>): {
  bash: HookShellExecutor
  requests: Record<string, unknown>[]
} {
  const requests: Record<string, unknown>[] = []
  const bash: HookShellExecutor = {
    async run(options: Record<string, unknown>): Promise<ShellRunResult> {
      requests.push(options)
      return run(options)
    },
  } as unknown as HookShellExecutor
  return { bash, requests }
}

function result(over: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    stdout: { text: "" },
    stderr: { text: "" },
    ...over,
  }
}

const clock = () => {
  let t = 0
  return () => (t += 5)
}
const testSignal = (): AbortSignal => new AbortController().signal

describe("runHook — payload + env + stdin plumbing", () => {
  it("requires an explicit caller-owned abort signal", () => {
    const opts: RunHookOptions = {
      payload: {},
      signal: new AbortController().signal,
      trailingNewline: true,
      defaultTimeoutMs: 1000,
    }
    expect(opts.signal).toBeDefined()
  })

  it("serializes the payload to stdin (with trailing newline when requested)", async () => {
    const { bash, requests } = recordingBash(async () => result({ stdout: { text: "" } }))
    await runHook(
      bash,
      { command: "my-hook.sh" },
      {
        payload: { hook_event_name: "PreToolUse", tool_name: "Bash" },
        signal: testSignal(),
        defaultTimeoutMs: 60000,
        trailingNewline: true,
      },
      clock(),
    )
    expect(requests[0]!.stdin).toBe(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }) + "\n")
    expect(requests[0]!.command).toBe("my-hook.sh")
  })

  it("omits the trailing newline when trailingNewline is false", async () => {
    const { bash, requests } = recordingBash(async () => result())
    await runHook(
      bash,
      { command: "h" },
      { payload: { a: 1 }, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: false },
      clock(),
    )
    expect(requests[0]!.stdin).toBe('{"a":1}')
  })

  it("threads env and cwd into the request", async () => {
    const { bash, requests } = recordingBash(async () => result())
    await runHook(
      bash,
      { command: "h" },
      {
        payload: {},
        env: { TRAYAMBAK_PROJECT_DIR: "/proj" },
        cwd: "/work",
        signal: testSignal(),
        defaultTimeoutMs: 1000,
        trailingNewline: true,
      },
      clock(),
    )
    expect(requests[0]!.env).toEqual({ TRAYAMBAK_PROJECT_DIR: "/proj" })
    expect(requests[0]!.workdir).toBe("/work")
  })

  it("a per-hook timeoutSec (seconds) overrides the default (ms)", async () => {
    const { bash, requests } = recordingBash(async () => result())
    await runHook(
      bash,
      { command: "h", timeoutSec: 3 },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true },
      clock(),
    )
    expect(requests[0]!.timeoutMs).toBe(3000)
  })

  it("falls back to the default timeout when the hook sets none", async () => {
    const { bash, requests } = recordingBash(async () => result())
    await runHook(
      bash,
      { command: "h" },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true },
      clock(),
    )
    expect(requests[0]!.timeoutMs).toBe(60000)
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000)
  })

  it("passes the abort signal through", async () => {
    const controller = new AbortController()
    const { bash, requests } = recordingBash(async () => result())
    await runHook(
      bash,
      { command: "h" },
      {
        payload: {},
        signal: controller.signal,
        defaultTimeoutMs: 1000,
        trailingNewline: true,
      },
      clock(),
    )
    expect(requests[0]!.signal).toBe(controller.signal)
  })
})

describe("runHook — outcome decoding + duration", () => {
  it("decodes a clean exit with structured stdout and reports a duration", async () => {
    const { bash } = recordingBash(async () =>
      result({
        exitCode: 0,
        stdout: { text: JSON.stringify({ decision: "block", reason: "no" }) },
      }),
    )
    const { output, durationMs } = await runHook(
      bash,
      { command: "h" },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true },
      clock(),
    )
    expect(output.decision).toBe("block")
    expect(output.reason).toBe("no")
    expect(durationMs).toBe(5)
  })

  it("a signal death (exitCode null) decodes as undefined exit (non-blocking error)", async () => {
    const { bash } = recordingBash(async () =>
      result({ exitCode: null, stdout: { text: "" }, stderr: { text: "killed" } }),
    )
    const { output } = await runHook(
      bash,
      { command: "h" },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true },
      clock(),
    )
    expect(output.exitCode).toBeUndefined()
    expect(output.decision).toBeUndefined()
    expect(output.stderr).toBe("killed")
  })

  it("an executor rejection (infra fault) becomes a non-blocking error, never throws", async () => {
    const { bash } = recordingBash(async () => {
      throw new Error("bad workdir: ENOENT")
    })
    const { output } = await runHook(
      bash,
      { command: "h" },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true },
      clock(),
    )
    expect(output.exitCode).toBeUndefined()
    expect(output.stderr).toBe("bad workdir: ENOENT")
    expect(output.decision).toBeUndefined()
  })

  it("a non-Error rejection is stringified onto stderr", async () => {
    const { bash } = recordingBash(async () => {
      throw "plain string fault"
    })
    const { output } = await runHook(
      bash,
      { command: "h" },
      { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true },
      clock(),
    )
    expect(output.stderr).toBe("plain string fault")
  })

  it("a mismatched hookSpecificOutput block is discarded", async () => {
    const { bash } = recordingBash(async () =>
      result({
        exitCode: 0,
        stdout: {
          text: JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
          }),
        },
      }),
    )
    const { output } = await runHook(
      bash,
      { command: "h" },
      {
        payload: {},
        signal: testSignal(),
        defaultTimeoutMs: 1000,
        trailingNewline: true,
        expectedEventName: "Stop",
      },
      clock(),
    )
    expect(output.hookEventName).toBe("PreToolUse")
    expect(output.decision).toBeUndefined()
  })
})

describe("parseHookOutput — exit 2 blocking", () => {
  it("exit 2 sets decision to block and uses stderr as reason", () => {
    const output = parseHookOutput(2, "", "tool not allowed")
    expect(output.decision).toBe("block")
    expect(output.reason).toBe("tool not allowed")
    expect(output.exitCode).toBe(2)
  })

  it("exit 0 with non-JSON stdout keeps stdout as-is", () => {
    const output = parseHookOutput(0, "hello world", "")
    expect(output.exitCode).toBe(0)
    expect(output.stdout).toBe("hello world")
    expect(output.decision).toBeUndefined()
  })

  it("invalid JSON on exit 0 is ignored, stdout remains", () => {
    const output = parseHookOutput(0, "{broken", "")
    expect(output.exitCode).toBe(0)
    expect(output.stdout).toBe("{broken")
    expect(output.decision).toBeUndefined()
  })
})

describe("mergeHookOutputs — most restrictive wins", () => {
  it("empty list yields neutral outcome", () => {
    const merged = mergeHookOutputs([])
    expect(merged.decision).toBe("none")
    expect(merged.stop).toBe(false)
    expect(merged.additionalContext).toEqual([])
  })

  it("deny overrides allow", () => {
    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: "", stdout: "", decision: "allow" },
      { exitCode: 0, stderr: "", stdout: "", decision: "deny", reason: "too risky" },
    ])
    expect(merged.decision).toBe("deny")
    expect(merged.reason).toBe("too risky")
  })

  it("ask is stricter than allow", () => {
    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: "", stdout: "", decision: "allow" },
      { exitCode: 0, stderr: "", stdout: "", decision: "ask" },
    ])
    expect(merged.decision).toBe("ask")
  })

  it("continue:false sets stop", () => {
    const merged = mergeHookOutputs([{ exitCode: 0, stderr: "", stdout: "", continue: false, stopReason: "done" }])
    expect(merged.stop).toBe(true)
    expect(merged.stopReason).toBe("done")
  })

  it("additionalContext accumulates in order", () => {
    const merged = mergeHookOutputs([
      { exitCode: 0, stderr: "", stdout: "", additionalContext: "ctx1" },
      { exitCode: 0, stderr: "", stdout: "", additionalContext: "ctx2" },
    ])
    expect(merged.additionalContext).toEqual(["ctx1", "ctx2"])
  })
})

describe("matchesMatcher — Trayambak regex mode", () => {
  it("absent/empty/`*` match all", () => {
    expect(matchesMatcher(undefined, "Bash")).toBe(true)
    expect(matchesMatcher("", "Bash")).toBe(true)
    expect(matchesMatcher("*", "Bash")).toBe(true)
  })

  it("valid regex matches", () => {
    expect(matchesMatcher("Bash|Write", "Bash")).toBe(true)
    expect(matchesMatcher("Bash|Write", "Write")).toBe(true)
    expect(matchesMatcher("Bash|Write", "Edit")).toBe(false)
  })

  it("invalid regex returns false (no throw)", () => {
    expect(matchesMatcher("[invalid", "Bash")).toBe(false)
  })
})

describe("matcherDiagnostic — config validation", () => {
  it("valid matchers return undefined", () => {
    expect(matcherDiagnostic(undefined)).toBeUndefined()
    expect(matcherDiagnostic("")).toBeUndefined()
    expect(matcherDiagnostic("*")).toBeUndefined()
    expect(matcherDiagnostic("Bash|Write")).toBeUndefined()
  })

  it("invalid regex returns a diagnostic", () => {
    const diag = matcherDiagnostic("[invalid")
    expect(diag).toContain("invalid")
    expect(diag).toContain("Trayambak")
  })
})

describe("summarizeStderr — truncation", () => {
  it("undefined when empty", () => {
    expect(summarizeStderr("", 500)).toBeUndefined()
    expect(summarizeStderr("   ", 500)).toBeUndefined()
  })

  it("passthrough when under limit", () => {
    expect(summarizeStderr("short error", 500)).toBe("short error")
  })

  it("truncates with ellipsis when over limit", () => {
    const long = "x".repeat(600)
    const summary = summarizeStderr(long, 500)
    expect(summary).toBeDefined()
    expect(summary!.length).toBe(501)
    expect(summary!.endsWith("\u2026")).toBe(true)
  })
})

describe("buildHookResult — durable entry construction", () => {
  it("builds with decision, exitCode, stderrSummary, duration", () => {
    const entry = buildHookResult(
      { turn: 1, point: "PreToolUse", dialect: "trayambak", handlerId: "h1" },
      { exitCode: 0, stderr: "warning text", stdout: "", decision: "allow", reason: "ok" },
      42,
      "sess_test123" as never,
    )
    expect(entry.turn).toBe(1)
    expect(entry.point).toBe("PreToolUse")
    expect(entry.handlerId).toBe("h1")
    expect(entry.decision).toBe("allow")
    expect(entry.exitCode).toBe(0)
    expect(entry.stderrSummary).toBe("warning text")
    expect(entry.durationMs).toBe(42)
  })

  it("decision falls back to stop/pass when no explicit decision", () => {
    const entryStop = buildHookResult(
      { turn: 1, point: "Stop", dialect: "trayambak", handlerId: "h1" },
      { exitCode: 0, stderr: "", stdout: "", continue: false },
      10,
      "sess_test" as never,
    )
    expect(entryStop.decision).toBe("stop")

    const entryPass = buildHookResult(
      { turn: 1, point: "Stop", dialect: "trayambak", handlerId: "h2" },
      { exitCode: 0, stderr: "", stdout: "" },
      10,
      "sess_test" as never,
    )
    expect(entryPass.decision).toBe("pass")
  })
})

describe("createDetachedRuns — quiescence tracking", () => {
  it("drain aborts and awaits all tracked runs", async () => {
    const tracker = createDetachedRuns()

    let completed1 = false
    let completed2 = false

    tracker.track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          completed1 = true
          resolve()
        }, 10)
      }),
    )
    tracker.track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          completed2 = true
          resolve()
        }, 10)
      }),
    )

    await tracker.drain()
    expect(completed1).toBe(true)
    expect(completed2).toBe(true)
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Tool-gate security wiring: audit rows, hook-payload redaction, and the
 * per-tool timeout ceiling. Deterministic via the shared harness — no
 * network, no processes, no ambient state.
 *
 * - recordAudit fires on every gate terminal (denied / success / error …);
 *   without a configured sink the loop runs exactly as before.
 * - Hook inputs are redactPayload'd: the stub executor's stdin must never
 *   carry raw key material, while the tool itself still executes with the
 *   real arguments (the approver and the tool need the truth; hook scripts
 *   and hook history only get the redacted copy).
 * - definition.timeoutMs binds first (tighter tool budget wins over the
 *   run-wide default; the run-wide default still caps generous tools —
 *   the latter direction is pinned by agent-loop-guards).
 */

import { describe, expect, it } from "vitest"
import { textResult, type Tool } from "../tools/types.js"
import type { HookShellExecutor } from "../tools/hook-exec.js"
import type { TrayambakConfig } from "../config.js"
import {
  assertProviderCalls,
  makeScriptedProvider,
  probeTool,
  runTestLoop,
  testBaseConfig,
  textReply,
  toolReply,
  toolTexts,
} from "./loop-test-harness.js"

interface AuditRow {
  action: string
  actor: string
  target: string
  result: string
}

function memoryAudit() {
  const rows: AuditRow[] = []
  return {
    rows,
    audit: {
      recordAudit(action: string, actor: string, target: string, result: string): void {
        rows.push({ action, actor, target, result })
      },
    },
  }
}

/** Stub executor that captures the stdin payload each hook would receive. */
function capturingExecutor() {
  const stdins: string[] = []
  const exec: HookShellExecutor = {
    run: async (options) => {
      stdins.push(String((options as { stdin?: unknown }).stdin ?? ""))
      return { exitCode: 0, stdout: { text: "{}" }, stderr: { text: "" } }
    },
  }
  return { exec, stdins }
}

describe("tool-gate audit (recordAudit)", () => {
  it("records a denied tool call and executes nothing", async () => {
    const mem = memoryAudit()
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: {
        mode: "default",
        rules: [],
        askByDefault: true,
        rulesV2: [{ tool: "probe", pattern: "*", action: "deny" }],
      },
    })
    await runTestLoop("go", config, scripted, { tools: [probeTool("probe", executed)], audit: mem.audit })
    expect(executed).toHaveLength(0)
    expect(mem.rows).toEqual([{ action: "tool.execute", actor: "agent", target: "probe", result: "denied" }])
    assertProviderCalls(scripted.calls(), 2, "audit deny turns")
  })

  it("records success when the tool runs clean", async () => {
    const mem = memoryAudit()
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    await runTestLoop("go", config, scripted, { tools: [probeTool("probe", executed)], audit: mem.audit })
    expect(executed).toEqual(['{"n":1}'])
    expect(mem.rows).toEqual([{ action: "tool.execute", actor: "agent", target: "probe", result: "success" }])
    assertProviderCalls(scripted.calls(), 2, "audit success turns")
  })

  it("records error when the tool throws", async () => {
    const mem = memoryAudit()
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    const { messages } = await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed, { throwMessage: "boom" })],
      audit: mem.audit,
    })
    expect(toolTexts(messages).join("\n")).toContain("Tool error: boom")
    expect(mem.rows).toEqual([{ action: "tool.execute", actor: "agent", target: "probe", result: "error" }])
    assertProviderCalls(scripted.calls(), 2, "audit error turns")
  })

  it("runs unchanged with no audit sink configured", async () => {
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    await runTestLoop("go", config, scripted, { tools: [probeTool("probe", executed)] })
    expect(executed).toEqual(['{"n":1}'])
    assertProviderCalls(scripted.calls(), 2, "no-audit turns")
  })

  it("a throwing sink never breaks the turn", async () => {
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed)],
      audit: {
        recordAudit(): void {
          throw new Error("store is on fire")
        },
      },
    })
    expect(executed).toEqual(['{"n":1}'])
    assertProviderCalls(scripted.calls(), 2, "throwing-audit turns")
  })
})

describe("hook-payload redaction in the loop", () => {
  it("hooks see redacted args while the tool executes with the real ones", async () => {
    const { exec, stdins } = capturingExecutor()
    const executed: string[] = []
    const secretArgs = {
      command: "deploy --token sk-abcdefghij1234567890",
      workdir: "C:\\work\\app",
    }
    const scripted = makeScriptedProvider([toolReply("c1", "probe", secretArgs), textReply("done")])
    const hooks = { preToolUse: [{ hooks: [{ command: "inspect.sh" }] }] } as unknown as TrayambakConfig["hooks"]
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
      hooks,
    })
    await runTestLoop("go", config, scripted, { tools: [probeTool("probe", executed)], hookExecutor: exec })

    // The tool ran with the truth (approval and execution are not redacted).
    expect(executed).toEqual([JSON.stringify(secretArgs)])

    // The hook payload only ever carried the redacted copy.
    expect(stdins).toHaveLength(1)
    const payload = JSON.parse(stdins[0]!) as { tool_input?: { command?: string; workdir?: string } }
    expect(payload.tool_input?.command).toBe("deploy --token [REDACTED]")
    expect(payload.tool_input?.command).not.toContain("sk-abcdefghij1234567890")
    // Ordinary values pass through byte-for-byte (never shredded).
    expect(payload.tool_input?.workdir).toBe("C:\\work\\app")
    assertProviderCalls(scripted.calls(), 2, "redact turns")
  })
})

describe("per-tool timeout ceiling", () => {
  it("a tighter definition.timeoutMs binds before the run-wide default", async () => {
    const executed: string[] = []
    const slowTool: Tool = {
      definition: {
        name: "probe",
        description: "slow double",
        parameters: { type: "object", properties: {}, required: [] },
        timeoutMs: 50,
      },
      execute: async (_id, args) => {
        executed.push(JSON.stringify(args))
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300)
        })
        return textResult("slow-done")
      },
    }
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    // Run default is 5s; the tool declares 50ms — the tool budget must win.
    const { messages } = await runTestLoop("go", testBaseConfig(), scripted, { tools: [slowTool] })
    expect(toolTexts(messages).join("\n")).toContain("Tool timed out: probe (50ms)")
    assertProviderCalls(scripted.calls(), 2, "definition-timeout turns")
  })
})

describe("tool context provider", () => {
  it("passes the run provider through to tool context", async () => {
    let seen: unknown = "unset"
    const spy: Tool = {
      definition: {
        name: "probe",
        description: "context spy",
        parameters: { type: "object", properties: {}, required: [] },
        timeoutMs: 5_000,
      },
      execute: async (_id, _args, _signal, _update, context) => {
        seen = context?.provider
        return textResult("ok")
      },
    }
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    await runTestLoop("go", config, scripted, { tools: [spy] })
    // runTestLoop feeds the scripted provider as the run provider.
    expect(seen).toBe(scripted.provider)
    assertProviderCalls(scripted.calls(), 2, "context-provider turns")
  })
})

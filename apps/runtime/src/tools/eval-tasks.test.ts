/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Deterministic task slate (hermes evals/readtool port, model-free).
 *
 *  Hermes scores REAL agents on hostile task slates (accuracy + api_turns +
 *  tool_calls + tokens). This is the deterministic half of that idea: a
 *  scripted provider (no network, no key) drives the REAL agent loop with
 *  REAL file tools inside a tmp workspace, and each task asserts the end
 *  state plus a turn budget. It catches harness regressions (dropped tool
 *  results, fuzzy-edit fallthrough, budget blowups) that unit tests miss.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { runAgentLoop } from "../agent/agent-loop.js"
import { Session } from "../session/session.js"
import { createWriteFileTool } from "./file-edit/write-file.js"
import { createEditFileTool } from "./file-edit/edit-file.js"
import { createReadFileTool } from "./file-edit/read-file.js"
import type { TrayambakConfig } from "../config.js"

interface ScriptStep {
  name: string
  args: Record<string, unknown>
}

function scriptedProvider(steps: ScriptStep[]): { provider: never; chats: () => number } {
  let n = 0
  let chats = 0
  const provider = {
    chat: async () => {
      chats++
      const step = steps[n++]
      if (!step) {
        return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end_turn" }
      }
      return {
        role: "assistant",
        content: [{ type: "toolCall", id: `c${n}`, name: step.name, arguments: step.args }],
        stopReason: "tool_use",
      }
    },
  } as never
  return { provider, chats: () => chats }
}

function taskCfg(dir: string): TrayambakConfig {
  return {
    maxTurns: 6,
    maxRetries: 0,
    retryDelayMs: 10,
    maxToolCalls: 10,
    maxParallelToolCalls: 4,
    toolCallRate: 0,
    maxDistinctToolCalls: 1000,
    cwd: dir,
    permissions: { mode: "default", rules: [], askByDefault: false },
  } as unknown as TrayambakConfig
}

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-eval-"))
  return dir
}

describe("agent task slate", () => {
  it("task write-file: creates the file with exact content within budget", async () => {
    const dir = tmpWorkspace()
    const { provider, chats } = scriptedProvider([
      { name: "write_file", args: { path: "notes.txt", content: "hello world\n" } },
    ])
    await runAgentLoop("create notes.txt containing hello world", {
      provider,
      tools: [createWriteFileTool() as never],
      session: new Session(),
      config: taskCfg(dir),
      emit: async () => {},
      onRequestPermission: async () => true,
    })
    expect(fs.readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("hello world\n")
    expect(chats()).toBeLessThanOrEqual(3)
  }, 15000)

  it("task fuzzy-edit: indentation-drifted old_string still lands", async () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, "app.js"), "function main() {\n    run();\n}\n", "utf8")
    const { provider, chats } = scriptedProvider([
      // Tab indent never occurs byte-exact — exercises the fuzzy fallback
      // through the real loop, not just the unit matcher.
      { name: "edit_file", args: { path: "app.js", old_string: "\trun();", new_string: "walk();" } },
    ])
    await runAgentLoop("change run() to walk() in app.js", {
      provider,
      tools: [createEditFileTool() as never],
      session: new Session(),
      config: taskCfg(dir),
      emit: async () => {},
      onRequestPermission: async () => true,
    })
    expect(fs.readFileSync(path.join(dir, "app.js"), "utf8")).toBe("function main() {\nwalk();\n}\n")
    expect(chats()).toBeLessThanOrEqual(3)
  }, 15000)

  it("task read-then-edit: two-step chain completes within budget", async () => {
    const dir = tmpWorkspace()
    fs.writeFileSync(path.join(dir, "cfg.txt"), "mode=dev\n", "utf8")
    const { provider, chats } = scriptedProvider([
      { name: "read_file", args: { path: "cfg.txt" } },
      { name: "edit_file", args: { path: "cfg.txt", old_string: "mode=dev", new_string: "mode=prod" } },
    ])
    await runAgentLoop("switch cfg.txt to prod mode", {
      provider,
      tools: [createReadFileTool() as never, createEditFileTool() as never],
      session: new Session(),
      config: taskCfg(dir),
      emit: async () => {},
      onRequestPermission: async () => true,
    })
    expect(fs.readFileSync(path.join(dir, "cfg.txt"), "utf8")).toBe("mode=prod\n")
    // Hermes metric: api turns for a 2-tool chain must stay tight.
    expect(chats()).toBeLessThanOrEqual(4)
  }, 15000)
})

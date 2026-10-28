/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildSessionTask,
  domainFor,
  pendingTaskDir,
  scheduleSessionImprovement,
  HARNESS_AUTO_KILL_SWITCH,
} from "./session-improve.js"

const realSession = [
  { role: "user", content: "Please add a retry to the HTTP client and cover it with a test" },
  { role: "assistant", content: "", toolName: "read_file" },
  { role: "assistant", content: "Added the retry and a unit test; the suite passes." },
]

describe("session-end harness task", () => {
  it("turns the last substantive request into a task", () => {
    const task = buildSessionTask({ cwd: "C:/work/Acme-Repo", messages: realSession })
    expect(task).not.toBeNull()
    expect(task!.request).toContain("retry")
    expect(task!.sourceDir).toBe("C:/work/Acme-Repo")
    expect(task!.domain).toBe("acme-repo")
    expect(task!.k).toBe(1)
    expect(task!.mode).toBe("parallel")
    expect(task!.notes).toContain("suite passes")
  })

  it("ignores chit-chat, slash commands and sessions that used no tools", () => {
    expect(buildSessionTask({ cwd: ".", messages: [{ role: "user", content: "hi" }] })).toBeNull()
    expect(
      buildSessionTask({
        cwd: ".",
        messages: [
          { role: "user", content: "/compact" },
          { role: "assistant", content: "ok", toolName: "bash" },
        ],
      }),
    ).toBeNull()
    expect(
      buildSessionTask({
        cwd: ".",
        messages: [
          { role: "user", content: "please refactor the parser module now" },
          { role: "assistant", content: "done" },
        ],
      }),
    ).toBeNull()
  })

  it("schedules nothing when the kill switch or the config disables it", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-auto-"))
    const base = { cwd: process.cwd(), messages: realSession, home }
    expect(scheduleSessionImprovement({ ...base, env: { [HARNESS_AUTO_KILL_SWITCH]: "1" } })).toBeNull()
    expect(scheduleSessionImprovement({ ...base, env: {}, config: { harnessAuto: false } })).toBeNull()
    expect(existsSync(pendingTaskDir(home))).toBe(false)
  })

  it("slugifies the workspace into a library area", () => {
    expect(domainFor("C:/Users/x/My Repo!")).toBe("my-repo")
    expect(domainFor("/")).toBe("default")
  })
})

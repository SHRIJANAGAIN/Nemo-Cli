/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildBashEnv, createBashTool, resetBackgroundJobsForTests } from "./bash.js"
import { DEFAULT_PERMISSIONS } from "../../../../../packages/protocol/src/permissions.js"
import type { NemoConfig } from "../../config.js"
import type { ToolContext, ToolResult } from "../types.js"

const SHELL = process.platform === "win32" ? "cmd /c" : "sh -c"
/** A command that keeps a background job alive long enough to poll/kill. */
const LONG_CMD = process.platform === "win32" ? "ping -n 9 127.0.0.1 > nul" : "sleep 8"

const ctxFor = (dir: string): ToolContext =>
  ({
    cwd: dir,
    config: {
      shellCommand: SHELL,
      maxOutputLines: 500,
      maxOutputBytes: 64 * 1024,
    } as unknown as NemoConfig,
    permissions: { ...DEFAULT_PERMISSIONS, askByDefault: false },
  }) as ToolContext

describe("bash tool", () => {
  let dir = ""

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bash-"))
  })

  afterEach(() => {
    resetBackgroundJobsForTests()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (args: Record<string, unknown>): Promise<ToolResult> =>
    createBashTool().execute("t1", args, undefined, undefined, ctxFor(dir))

  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  const pollUntilDone = async (id: string): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const poll = await run({ job_id: id })
      const text = textOf(poll)
      if (text.includes("finished")) return text
      if (text.includes("Unknown job_id")) return text
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`job ${id} never finished`)
  }

  it("runs a foreground command and returns its output", async () => {
    const res = await run({ command: "echo fg-done" })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain("fg-done")
  })

  it("reports a failing foreground command with its exit code", async () => {
    const res = await run({ command: "exit 3" })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("[exit code 3]")
  })

  it("declares an outer ceiling covering the foreground max (no 30s kill)", async () => {
    // The runner kills at definition.timeoutMs no matter what the tool was
    // asked: at 30s every build died with "Tool timed out: bash (30000ms)".
    expect(createBashTool().definition.timeoutMs).toBe(300_000)
  })

  it("honors an explicit per-call timeout (fast fail, honest message)", async () => {
    const slow = process.platform === "win32" ? "ping -n 3 127.0.0.1 > nul" : "sleep 2"
    const res = await run({ command: slow, timeout: 1 })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("timed out after 1s")
  })

  it("lets short commands finish with no timeout arg (no hair-trigger default)", async () => {
    const slow = process.platform === "win32" ? "ping -n 3 127.0.0.1 > nul" : "sleep 2"
    const res = await run({ command: slow })
    expect(res.isError).toBeFalsy()
  })

  it("passes quoted command text through the shell unmangled (#75)", async () => {
    // Windows CRT-escaping used to turn `node -e "..."` into a string
    // literal: exit 0, silently no output — and `echo "hi"` printed
    // `\"hi\"`. The raw command must reach the shell exactly as typed.
    const res = await run({ command: `node -e "process.stdout.write('q-ok')"` })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain("q-ok")
  })

  it("rejects a missing command", async () => {
    const res = await run({})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe("Missing 'command'.")
  })

  it("starts a background job, returns its id, and yields output when done", async () => {
    const start = await run({ command: "echo bg-done", background: true })
    expect(start.isError).toBeFalsy()
    const startText = textOf(start)
    expect(startText).toContain("Background job started.")
    const id = /job_id: ([0-9a-f-]+)/.exec(startText)?.[1]
    expect(id).toBeTruthy()

    const final = await pollUntilDone(id as string)
    expect(final).toContain(`Job ${id} finished`)
    expect(final).toContain("bg-done")
    expect(final).not.toContain("[exit code")
  })

  it("reports a still-running job and supports killing it", async () => {
    const start = await run({ command: LONG_CMD, background: true })
    const id = /job_id: ([0-9a-f-]+)/.exec(textOf(start))?.[1] as string
    expect(id).toBeTruthy()

    const running = await run({ job_id: id })
    expect(textOf(running)).toContain("still running")
    expect(textOf(running)).toContain(LONG_CMD)

    const killed = await run({ job_id: id, action: "kill" })
    expect(textOf(killed)).toContain("killed")

    const final = await pollUntilDone(id)
    expect(final).toContain("finished")
    expect(final).toContain("[killed on request]")
  })

  it("rejects unknown job ids", async () => {
    const res = await run({ job_id: "not-a-real-job" })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("Unknown job_id")
  })

  it("rejects unknown actions before looking up the job", async () => {
    const res = await run({ job_id: "whatever", action: "explode" })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("Unknown action")
  })

  it("caps the number of concurrent background jobs", async () => {
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const start = await run({ command: LONG_CMD, background: true })
      const id = /job_id: ([0-9a-f-]+)/.exec(textOf(start))?.[1]
      expect(id).toBeTruthy()
      ids.push(id as string)
    }
    const ninth = await run({ command: LONG_CMD, background: true })
    expect(ninth.isError).toBe(true)
    expect(textOf(ninth)).toContain("Too many background jobs")
  }, 30_000)

  it("builds a child env that keeps PATH, HOME, TEMP and USERPROFILE", () => {
    const out = buildBashEnv(
      {
        PATH: "/usr/bin",
        Path: "C:\\Windows\\System32", // Windows spells it "Path"; keep both spellings
        HOME: "/home/dev",
        TEMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\dev",
        LANG: "en_US.UTF-8",
      },
      "policy-only",
      false,
    )
    expect(out.PATH).toBe("/usr/bin")
    expect(out.Path).toBe("C:\\Windows\\System32")
    expect(out.HOME).toBe("/home/dev")
    expect(out.TEMP).toBe("C:\\Temp")
    expect(out.USERPROFILE).toBe("C:\\Users\\dev")
    expect(out.LANG).toBe("en_US.UTF-8")
    expect(out.NEMO_SANDBOX).toBe("policy-only")
  })

  it("drops the secrets the deny-list-only filter misses", () => {
    // Audit 4.1: core's getSafeEnv lets every one of these through; only
    // the sandbox allowlist catches them.
    const out = buildBashEnv(
      {
        PATH: "/usr/bin",
        DATABASE_URL: "postgres://prod",
        SENTRY_DSN: "https://o@ingest.example",
        SLACK_WEBHOOK: "https://hooks.slack.example",
        NPM_AUTH: "_npm_token_value",
        DOCKER_CONFIG: "/home/dev/.docker",
        SECRET_TOKEN: "blocked",
      },
      "policy-only",
      false,
    )
    expect(out.PATH).toBe("/usr/bin")
    expect(out.DATABASE_URL).toBeUndefined()
    expect(out.SENTRY_DSN).toBeUndefined()
    expect(out.SLACK_WEBHOOK).toBeUndefined()
    expect(out.NPM_AUTH).toBeUndefined()
    expect(out.DOCKER_CONFIG).toBeUndefined()
    expect(out.SECRET_TOKEN).toBeUndefined()
  })

  it("proves it end to end: the child sees PATH/HOME but never DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://must-not-leak")
    vi.stubEnv("HOME", path.join(dir, "stub-home"))
    const res = await run({ command: process.platform === "win32" ? "set" : "env" })
    expect(res.isError).toBeFalsy()
    const seen = textOf(res).toLowerCase()
    expect(seen).not.toContain("database_url")
    expect(seen).toContain("path=")
    expect(seen).toContain("home=")
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as ManagerModule from "./manager.js"

/**
 * managerCommand fans out to plan/todo/tasks stores that all bake
 * `os.homedir()` at module load, plus loadConfig() which reads
 * `<cwd>/.trayambak/config.json` at call time. So: install a temp home AND a
 * temp cwd (with its own .trayambak) before the dynamic import, restore the
 * environment immediately after, and keep cwd inside the sandbox for the whole
 * file — the real ~/.trayambak and the repo's .trayambak/ are never touched.
 */

let manager: typeof ManagerModule
let home = ""
let tmp = ""
let originalCwd = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined
const savedEnv: Record<string, string | undefined> = {}

const ENV_KEYS = [
  "TRAYAMBAK_MODEL",
  "TRAYAMBAK_PROVIDER",
  "TRAYAMBAK_BASE_URL",
  "TRAYAMBAK_API_KEY",
  "TRAYAMBAK_CWD",
  "TRAYAMBAK_MAX_TURNS",
  "TRAYAMBAK_MAX_PARALLEL_TOOL_CALLS",
] as const

const tasksFile = (): string => path.join(home, ".trayambak", "tasks.json")
const planDir = (): string => path.join(home, ".trayambak", "plans")
const todoFile = (): string => path.join(home, ".trayambak", "todos", "global.json")
const agentFile = (): string => path.join(tmp, ".trayambak", "agents", "test-reviewer.md")

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
}

function seedTasks(): void {
  writeJson(tasksFile(), {
    tasks: [{ id: "task_1", content: "Ship release", status: "pending", priority: "high", createdAt: 1, updatedAt: 1 }],
  })
}

function seedPlan(): void {
  writeJson(path.join(planDir(), "plan-seed1.json"), {
    id: "plan-seed1",
    name: "Release",
    description: "",
    status: "active",
    steps: [],
    createdAt: 1,
    updatedAt: 1,
  })
}

function seedTodo(): void {
  writeJson(todoFile(), {
    items: [{ id: 1, content: "Do thing", status: "in_progress", createdAt: 1, updatedAt: 1 }],
  })
}

function seedConfig(): void {
  writeJson(path.join(tmp, ".trayambak", "config.json"), {
    model: "mgr-model",
    provider: "ollama",
    maxTurns: 42,
    maxParallelToolCalls: 7,
  })
}

function seedAgent(): void {
  const file = agentFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    "---\nname: Test Reviewer\ndescription: Reviews things for tests\n---\nYou are a test agent.\n",
    "utf8",
  )
}

beforeAll(async () => {
  originalCwd = process.cwd()
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-manager-home-"))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-manager-cwd-"))
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  delete process.env.TRAYAMBAK_MODEL
  delete process.env.TRAYAMBAK_PROVIDER
  delete process.env.TRAYAMBAK_BASE_URL
  delete process.env.TRAYAMBAK_API_KEY
  delete process.env.TRAYAMBAK_CWD
  delete process.env.TRAYAMBAK_MAX_TURNS
  delete process.env.TRAYAMBAK_MAX_PARALLEL_TOOL_CALLS

  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.chdir(tmp)
  manager = await import("./manager.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
}, 60_000)

afterAll(() => {
  process.chdir(originalCwd)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const dir of [home, tmp]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

beforeEach(() => {
  fs.rmSync(path.join(tmp, ".trayambak"), { recursive: true, force: true })
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })
  for (const dir of [path.dirname(tasksFile()), planDir(), path.dirname(todoFile())]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("managerCommand status", () => {
  it("renders resolved config values", () => {
    seedConfig()

    expect(manager.managerCommand({ action: "status" })).toBe(
      [
        "trayambak Manager Status",
        `cwd: ${tmp}`,
        "model: mgr-model",
        "provider: ollama",
        "maxTurns: 42",
        "maxParallelToolCalls: 7",
      ].join("\n"),
    )
  })
})

describe("managerCommand agents", () => {
  it("lists discovered profiles with id, category and name", () => {
    seedAgent()

    const out = manager.managerCommand({ action: "agents" })
    expect(out).toMatch(/^Available agents \(\d+\):\n/)
    // Bundled profiles are always present, so assert inclusion of the
    // project-local one rather than an exact roster.
    expect(out).toContain(`  - ${agentFile()} [reviewer] Test Reviewer`)
  })
})

describe("managerCommand tasks", () => {
  it("reports an empty list", () => {
    expect(manager.managerCommand({ action: "tasks" })).toBe("No tasks")
  })

  it("renders persisted tasks", () => {
    seedTasks()

    expect(manager.managerCommand({ action: "tasks" })).toBe("Tasks (1):\n  - task_1 | pending | Ship release")
  })
})

describe("managerCommand plans", () => {
  it("reports an empty list", () => {
    expect(manager.managerCommand({ action: "plans" })).toBe("No plans")
  })

  it("renders persisted plans", () => {
    seedPlan()

    expect(manager.managerCommand({ action: "plans" })).toBe("Plans (1):\n  - plan-seed1: Release [active]")
  })
})

describe("managerCommand todos", () => {
  it("reports an empty list", () => {
    expect(manager.managerCommand({ action: "todos" })).toBe("No todos")
  })

  it("renders todos for the requested session", () => {
    seedTodo()

    expect(manager.managerCommand({ action: "todos" })).toBe("Todos (1):\n  - #1 [in_progress] Do thing")
    expect(manager.managerCommand({ action: "todos", sessionId: "other-session" })).toBe("No todos")
  })
})

describe("managerCommand summary", () => {
  it("counts each collection on its own line", () => {
    seedConfig()
    seedAgent()
    seedTasks()
    seedPlan()
    seedTodo()

    expect(manager.managerCommand({ action: "summary" })).toMatch(
      /^trayambak Manager Summary\nagents: \d+\ntasks: 1\nplans: 1\ntodos: 1$/,
    )
  })
})

describe("managerCommand unknown action", () => {
  it("reports the unhandled action name", () => {
    expect(manager.managerCommand({ action: "bogus" as never })).toBe("Unknown manager action: bogus")
  })
})

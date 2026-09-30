/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as TaskModule from "./task.js"

/**
 * tasks.ts pins its store to `path.join(os.homedir(), ".trayambak")` AT MODULE
 * LOAD, so a throwaway home is installed before the dynamic import below — the
 * real ~/.trayambak/tasks.json is never read or written. `import type` is
 * erased at compile time and cannot pull the module in early.
 *
 * Only the two paths taskCommand touches are persisted by hand (the store is a
 * plain JSON file); taskCommand itself decides what to print.
 */

let task: typeof TaskModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const tasksFile = (): string => path.join(home, ".trayambak", "tasks.json")

interface StoredTask {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "low" | "medium" | "high"
  createdAt?: number
  updatedAt?: number
}

function seedTasks(tasks: StoredTask[]): void {
  fs.mkdirSync(path.dirname(tasksFile()), { recursive: true })
  fs.writeFileSync(tasksFile(), JSON.stringify({ tasks }, null, 2), "utf8")
}

function storedTasks(): StoredTask[] {
  return (JSON.parse(fs.readFileSync(tasksFile(), "utf8")) as { tasks: StoredTask[] }).tasks
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-task-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  task = await import("./task.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
}, 60_000)

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

beforeEach(() => {
  fs.rmSync(path.dirname(tasksFile()), { recursive: true, force: true })
})

describe("taskCommand list", () => {
  it("reports an empty list without touching disk", () => {
    expect(task.taskCommand({ action: "list" })).toBe("No tasks")
    expect(fs.existsSync(tasksFile())).toBe(false)
  })

  it("formats persisted tasks as id | status [priority] | content", () => {
    seedTasks([
      { id: "task_1", content: "Ship release", status: "pending", priority: "high" },
      { id: "task_2", content: "Close incident", status: "completed" },
    ])

    expect(task.taskCommand({ action: "list" })).toBe(
      "task_1 | pending [high] | Ship release\ntask_2 | completed | Close incident",
    )
  })

  it("ignores a malformed store instead of throwing", () => {
    fs.mkdirSync(path.dirname(tasksFile()), { recursive: true })
    fs.writeFileSync(tasksFile(), "{ not json", "utf8")

    expect(task.taskCommand({ action: "list" })).toBe("No tasks")
  })
})

describe("taskCommand create", () => {
  it("requires content", () => {
    expect(task.taskCommand({ action: "create" })).toBe("Missing content")
    expect(fs.existsSync(tasksFile())).toBe(false)
  })

  it("echoes the queued content without persisting anything", () => {
    expect(task.taskCommand({ action: "create", content: "Ship release" })).toBe("[Task queued] Ship release")
    // create is a pure acknowledgement; nothing lands in the store.
    expect(fs.existsSync(tasksFile())).toBe(false)
  })

  it("truncates long content to 200 characters", () => {
    const out = task.taskCommand({ action: "create", content: "x".repeat(300) })

    expect(out).toBe(`[Task queued] ${"x".repeat(200)}`)
    expect(out.length).toBe("[Task queued] ".length + 200)
  })
})

describe("taskCommand update/get/output", () => {
  it("update requires an id", () => {
    expect(task.taskCommand({ action: "update", status: "completed" })).toBe("Missing task id")
  })

  it("update acknowledges the task id", () => {
    expect(task.taskCommand({ action: "update", id: "task_1", status: "completed" })).toBe("Task task_1 updated")
  })

  it("get requires an id and echoes it", () => {
    expect(task.taskCommand({ action: "get" })).toBe("Missing task id")
    expect(task.taskCommand({ action: "get", id: "task_9" })).toBe("Task task_9")
  })

  it("output requires an id and appends 'output'", () => {
    expect(task.taskCommand({ action: "output" })).toBe("Missing task id")
    expect(task.taskCommand({ action: "output", id: "task_9" })).toBe("Task task_9 output")
  })
})

describe("taskCommand reset", () => {
  it("clears the persisted store", () => {
    seedTasks([{ id: "task_1", content: "Ship release", status: "pending" }])

    expect(task.taskCommand({ action: "reset" })).toBe("Tasks reset")
    expect(storedTasks()).toEqual([])
  })

  it("resets cleanly when no store exists yet", () => {
    expect(task.taskCommand({ action: "reset" })).toBe("Tasks reset")
    expect(storedTasks()).toEqual([])
  })
})

describe("taskCommand unknown action", () => {
  it("reports the unhandled action name", () => {
    expect(task.taskCommand({ action: "bogus" as never })).toBe("Unknown task action: bogus")
  })
})

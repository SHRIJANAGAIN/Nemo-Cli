/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as TasksModule from "./tasks.js"

/**
 * tasks.ts pins TASKS_FILE to os.homedir() AT MODULE LOAD, so a throwaway
 * home is installed before the dynamic import below — the real
 * ~/.trayambak/tasks.json is never read or written. `import type` above is
 * erased and cannot pull the module in early. (Round 12: the CLI `task`
 * command was rewired onto the shared addTask/updateTask mutators, and the
 * create/update tools now go through the same path — one store, one truth.)
 */

let tasks: typeof TasksModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const storeFile = (): string => path.join(home, ".trayambak", "tasks.json")

interface StoredTask {
  id: string
  content: string
  status: string
  priority?: string
  result?: string
}

const readStore = (): StoredTask[] =>
  (JSON.parse(fs.readFileSync(storeFile(), "utf8")) as { tasks: StoredTask[] }).tasks

const body = (r: { content: Array<{ text?: string }> }): string =>
  r.content.map((c) => c.text ?? "").join("")

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-tasks-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  tasks = await import("./tasks.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
})

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

beforeEach(() => {
  tasks.resetTasks()
  fs.rmSync(storeFile(), { force: true })
})

describe("shared store mutators", () => {
  it("addTask persists with a generated id and defaults", () => {
    const created = tasks.addTask("Ship release", { priority: "high", dependsOn: ["a", "b"], batchId: 7 })

    expect(created.id).toMatch(/^task_[a-z0-9]+_[a-z0-9]+$/)
    expect(created).toMatchObject({
      content: "Ship release",
      status: "pending",
      priority: "high",
      dependsOn: ["a", "b"],
      batchId: "7",
    })
    expect(readStore()).toHaveLength(1)
    expect(tasks.getTask(created.id)?.content).toBe("Ship release")
  })

  it("addTask drops junk priority and non-array dependsOn instead of persisting them", () => {
    const created = tasks.addTask("t", { priority: "urgent" as never, dependsOn: "nope" as never })

    expect(created.priority).toBeUndefined()
    expect(created.dependsOn).toBeUndefined()
    expect(readStore()[0].priority).toBeUndefined()
  })

  it("updateTask applies defined fields only and reports a missing id as null", () => {
    const created = tasks.addTask("t")

    const updated = tasks.updateTask(created.id, { status: "completed", priority: "low", result: "done" })
    expect(updated).toMatchObject({ status: "completed", priority: "low", result: "done" })
    expect(readStore()[0]).toMatchObject({ status: "completed", result: "done" })

    // Undefined fields are left alone (not clobbered).
    const partial = tasks.updateTask(created.id, {})
    expect(partial).toMatchObject({ status: "completed", priority: "low", result: "done" })

    expect(tasks.updateTask("task_ghost_1", { status: "pending" })).toBeNull()
  })
})

describe("task tools share the same store (round 12 attack)", () => {
  it("TaskCreate really persists — 'created' is never an empty promise", async () => {
    const tool = tasks.createTaskCreateTool()

    const missing = await tool.execute("c1", {}, undefined)
    expect(body(missing)).toBe("Missing 'content'.")
    expect(missing.isError).toBe(true)

    const ok = await tool.execute("c2", { content: "Write the report", priority: "medium" }, undefined)
    expect(body(ok)).toMatch(/^Task task_[a-z0-9]+_[a-z0-9]+ created: Write the report$/)
    expect(readStore()).toHaveLength(1)
    expect(readStore()[0]).toMatchObject({ content: "Write the report", priority: "medium" })
  })

  it("TaskUpdate validates, persists through updateTask, and reports unknown ids", async () => {
    const tool = tasks.createTaskUpdateTool()
    const created = tasks.addTask("t")

    const ghost = await tool.execute("u1", { id: "task_ghost_1", status: "completed" }, undefined)
    expect(body(ghost)).toBe("No such task: task_ghost_1")
    expect(ghost.isError).toBe(true)

    const badStatus = await tool.execute("u2", { id: created.id, status: "banana" }, undefined)
    expect(body(badStatus)).toBe("Invalid status: banana")
    expect(readStore()[0].status).toBe("pending")

    const ok = await tool.execute("u3", { id: created.id, status: "completed", result: "shipped" }, undefined)
    expect(body(ok)).toBe(`Task ${created.id} → completed`)
    expect(readStore()[0]).toMatchObject({ status: "completed", result: "shipped" })
  })

  it("TaskGet and TaskOutput read the same row the CLI writes", async () => {
    const created = tasks.addTask("row", { priority: "high" })

    expect(body(await tasks.createTaskGetTool().execute("g1", { id: created.id }, undefined))).toBe(
      `${created.id} | pending [high] | row`,
    )
    expect(body(await tasks.createTaskOutputTool().execute("o1", { id: created.id }, undefined))).toBe(
      "Task not completed (status: pending)",
    )

    tasks.updateTask(created.id, { status: "completed", result: "ok" })
    expect(body(await tasks.createTaskOutputTool().execute("o2", { id: created.id }, undefined))).toBe("ok")
  })
})

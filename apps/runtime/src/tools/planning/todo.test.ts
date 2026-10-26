/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolContext, ToolResult } from "../types.js"

interface Item {
  id: number
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "low" | "medium" | "high"
  dependsOn?: number[]
  createdAt: number
  updatedAt: number
}

let tmp = ""
let todosDir = ""
let globalFile = ""
let mod: typeof import("./todo.js")
let tool: ReturnType<typeof import("./todo.js").createTodoTool>
const savedEnv: Record<string, string | undefined> = {}

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

const ctx = (sessionId: string): ToolContext => ({ sessionId }) as unknown as ToolContext

const run = (
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; sessionId?: string } = {},
): Promise<ToolResult> =>
  tool.execute("call-1", args, opts.signal, undefined, opts.sessionId !== undefined ? ctx(opts.sessionId) : undefined)

const item = (id: number, status: Item["status"], priority?: Item["priority"]): Item => ({
  id,
  content: `t${id}`,
  status,
  priority,
  createdAt: 0,
  updatedAt: 0,
})

beforeAll(async () => {
  savedEnv.USERPROFILE = process.env.USERPROFILE
  savedEnv.HOME = process.env.HOME
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEMO_")) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-todo-"))
  process.env.USERPROFILE = tmp
  process.env.HOME = tmp
  // TODO_DIR bakes os.homedir() at module load, so import only after redirect.
  mod = await import("./todo.js")
  tool = mod.createTodoTool()
  todosDir = path.join(tmp, ".nemo", "todos")
  globalFile = path.join(todosDir, "global.json")
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(todosDir, { recursive: true, force: true })
})

describe("todo tool definition", () => {
  it("declares the action enum and per-action parameters", () => {
    const params = tool.definition.parameters as unknown as {
      required: string[]
      properties: Record<string, { type?: string; enum?: string[] }>
    }
    expect(tool.definition.name).toBe("todo")
    expect(tool.definition.description).toContain("to-do")
    expect(params.required).toEqual(["action"])
    expect(params.properties.action?.enum).toEqual(["read", "write", "update", "clear"])
    expect(params.properties.id?.type).toBe("integer")
    expect(params.properties.status?.enum).toEqual(["pending", "in_progress", "completed"])
    expect(params.properties.priority?.enum).toEqual(["low", "medium", "high"])
    expect(params.properties.dependsOn?.type).toBe("array")
  })
})

describe("todo tool execution", () => {
  it("returns aborted without touching disk when the signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await run({ action: "read" }, { signal: controller.signal })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe("aborted")
    expect(fs.existsSync(todosDir)).toBe(false)
  })

  it("reads an empty session as (no todos)", async () => {
    const res = await run({ action: "read" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("(no todos)")
  })

  it("requires non-empty content for write", async () => {
    const blank = await run({ action: "write", content: "   " })
    expect(blank.isError).toBe(true)
    expect(textOf(blank)).toBe("Missing 'content'.")

    const missing = await run({ action: "write" })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("Missing 'content'.")
    expect(fs.existsSync(globalFile)).toBe(false)
  })

  it("writes the first item, renders it in full, and snapshots the prior list", async () => {
    const res = await run({
      action: "write",
      content: "Buy milk",
      priority: "high",
      dependsOn: [1],
    })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toContain("[ ] #1 (high) Buy milk")

    const raw = JSON.parse(fs.readFileSync(globalFile, "utf8")) as {
      items: Item[]
      before: Item[]
    }
    expect(raw.items).toHaveLength(1)
    expect(raw.items[0]).toMatchObject({
      id: 1,
      content: "Buy milk",
      status: "pending",
      priority: "high",
      dependsOn: [1],
    })
    expect(raw.before).toEqual([])
  })

  it("increments ids across writes and drops invalid priorities", async () => {
    await run({ action: "write", content: "first", priority: "urgent" })
    const second = await run({ action: "write", content: "second", priority: "low" })

    expect(textOf(second)).toContain("#1 first")
    expect(textOf(second)).toContain("#2 (low) second")

    const raw = JSON.parse(fs.readFileSync(globalFile, "utf8")) as { items: Item[] }
    expect(raw.items.map((i) => i.id)).toEqual([1, 2])
    expect(raw.items[0]).not.toHaveProperty("priority")
    expect(raw.items[1]?.priority).toBe("low")
  })

  it("scopes files by session id, trimming whitespace and falling back to global", async () => {
    await run({ action: "write", content: "session item" }, { sessionId: "  sess-1  " })
    expect(fs.existsSync(path.join(todosDir, "sess-1.json"))).toBe(true)
    expect(fs.existsSync(globalFile)).toBe(false)

    await run({ action: "write", content: "global item" }, { sessionId: "   " })
    expect(fs.existsSync(globalFile)).toBe(true)
  })

  it("reads back only the session's own items", async () => {
    await run({ action: "write", content: "alpha" }, { sessionId: "sess-a" })
    const mine = await run({ action: "read" }, { sessionId: "sess-a" })
    expect(textOf(mine)).toContain("alpha")

    const other = await run({ action: "read" }, { sessionId: "sess-b" })
    expect(textOf(other)).toBe("(no todos)")
  })

  it("validates id and status on update", async () => {
    await run({ action: "write", content: "seed" })

    const badId = await run({ action: "update", id: "abc", status: "pending" })
    expect(badId.isError).toBe(true)
    expect(textOf(badId)).toBe("Need numeric 'id' and 'status'.")

    const noStatus = await run({ action: "update", id: 1 })
    expect(noStatus.isError).toBe(true)
    expect(textOf(noStatus)).toBe("Need numeric 'id' and 'status'.")

    const missing = await run({ action: "update", id: 99, status: "pending" })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("No todo with id 99.")

    const badStatus = await run({ action: "update", id: 1, status: "done" })
    expect(badStatus.isError).toBe(true)
    expect(textOf(badStatus)).toBe("status must be pending|in_progress|completed")
  })

  it("renders the full list when an update makes the list terminal", async () => {
    await run({ action: "write", content: "only task" })
    const res = await run({ action: "update", id: 1, status: "completed" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toContain("[x] #1 only task")

    const raw = JSON.parse(fs.readFileSync(globalFile, "utf8")) as { items: Item[] }
    expect(raw.items[0]?.status).toBe("completed")
  })

  it("reports (no changes) for a non-terminal update", async () => {
    await run({ action: "write", content: "one" })
    await run({ action: "write", content: "two" })
    const res = await run({ action: "update", id: 1, status: "in_progress" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("(no changes)")

    const raw = JSON.parse(fs.readFileSync(globalFile, "utf8")) as { items: Item[] }
    expect(raw.items[0]?.status).toBe("in_progress")
    expect(raw.items[1]?.status).toBe("pending")
  })

  it("updates and clears priority and dependsOn on update", async () => {
    await run({ action: "write", content: "task", priority: "high" })

    await run({ action: "update", id: 1, status: "pending", priority: "low", dependsOn: [2] })
    const first = mod.loadTodoList()
    expect(first.items[0]?.priority).toBe("low")
    expect(first.items[0]?.dependsOn).toEqual([2])

    await run({ action: "update", id: 1, status: "pending", priority: "bogus", dependsOn: "x" })
    const second = mod.loadTodoList()
    expect(second.items[0]).not.toHaveProperty("priority")
    expect(second.items[0]).not.toHaveProperty("dependsOn")
  })

  it("clears the list and keeps the pre-clear snapshot", async () => {
    await run({ action: "write", content: "one" })
    await run({ action: "write", content: "two" })
    const res = await run({ action: "clear" })
    expect(textOf(res)).toBe("(todos cleared)")

    const raw = JSON.parse(fs.readFileSync(globalFile, "utf8")) as {
      items: Item[]
      before: Item[]
    }
    expect(raw.items).toEqual([])
    expect(raw.before).toHaveLength(2)

    const after = await run({ action: "read" })
    expect(textOf(after)).toBe("(no todos)")
  })

  it("rejects unknown or missing actions", async () => {
    const unknown = await run({ action: "dance" })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toBe("action must be read|write|update|clear")

    const missing = await run({})
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("action must be read|write|update|clear")
  })

  it("treats a corrupt session file as empty", async () => {
    fs.mkdirSync(todosDir, { recursive: true })
    fs.writeFileSync(globalFile, "{ not json", "utf8")
    const res = await run({ action: "read" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("(no todos)")
  })

  it("exposes the persisted list through loadTodoList", async () => {
    await run({ action: "write", content: "persisted" }, { sessionId: "sess-x" })
    const list = mod.loadTodoList("sess-x")
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.content).toBe("persisted")
    expect(mod.loadTodoList("never-written").items).toEqual([])
  })
})

describe("renderTodoDiff", () => {
  it("returns (no todos) for an empty list even with a snapshot", () => {
    expect(mod.renderTodoDiff({ items: [] })).toBe("(no todos)")
    expect(mod.renderTodoDiff({ items: [], before: [item(1, "pending")] })).toBe("(no todos)")
  })

  it("renders every status icon and priority marker without a snapshot", () => {
    const out = mod.renderTodoDiff({
      items: [item(1, "pending"), item(2, "in_progress", "low"), item(3, "completed", "high")],
    })
    const lines = out.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(" [ ] #1 t1")
    expect(lines[1]).toBe(" [*] #2 (low) t2")
    expect(lines[2]).toBe(" [x] #3 (high) t3")
  })

  it("renders the full list when there is no snapshot", () => {
    expect(mod.renderFull([])).toBe("(no todos)")
    const out = mod.renderFull([item(1, "pending")])
    expect(out).toBe(" [ ] #1 t1")
    // No-snapshot diff rendering falls back to the full view.
    expect(mod.renderTodoDiff({ items: [item(1, "pending")] })).toBe(out)
  })

  it("shows only the changed window with hidden counters in compact mode", () => {
    const before = [1, 2, 3, 4, 5, 6].map((id) => item(id, "pending"))
    const after = before.map((it, idx) => ({
      ...it,
      status: (idx === 3 ? "in_progress" : "pending") as Item["status"],
    }))
    const lines = mod.renderTodoDiff({ items: after, before }).split("\n")
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe("... 2 hidden before, 1 hidden after ...")
    expect(lines[1]).toBe(" [ ] #3 t3")
    expect(lines[2]).toBe(">[*] #4 t4")
    expect(lines[3]).toBe(" [ ] #5 t5")
  })

  it("reports (no changes) when nothing differs from the snapshot", () => {
    const before = [item(1, "pending"), item(2, "in_progress")]
    const after = before.map((it) => ({ ...it }))
    expect(mod.renderTodoDiff({ items: after, before })).toBe("(no changes)")
  })

  it("shows the full list once every item is completed", () => {
    const before = [item(1, "pending"), item(2, "pending")]
    const after = before.map((it) => ({ ...it, status: "completed" as const }))
    const out = mod.renderTodoDiff({ items: after, before })
    expect(out.split("\n")).toEqual([" [x] #1 t1", " [x] #2 t2"])
  })

  it("treats snapshot entries that do not line up as changed", () => {
    // before is present but shorter than items, so before[0] is missing
    // for the appended todo and sameTodo falls through to false.
    const out = mod.renderTodoDiff({ items: [item(7, "pending")], before: [] })
    expect(out).toContain("#7 t7")
    expect(out).not.toBe("(no changes)")
  })
})

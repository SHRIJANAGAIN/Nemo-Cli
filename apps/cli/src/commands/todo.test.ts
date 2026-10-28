/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as TodoModule from "./todo.js"

/**
 * todo.ts resolves its storage root from os.homedir() AT MODULE LOAD, so the
 * temp home is installed before the dynamic import in beforeAll and the real
 * ~/.nemo/todos is never read or written. `import type` above is erased,
 * so it cannot pull the module in early.
 */

let todo: typeof TodoModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const todoDir = (): string => path.join(home, ".nemo", "todos")

function todoFile(sessionId?: string): string {
  const id = sessionId && sessionId.trim() ? sessionId.trim() : "global"
  return path.join(todoDir(), `${id}.json`)
}

function readTodos(sessionId?: string): Array<{ id: number; content: string; status: string; priority?: string }> {
  const parsed = JSON.parse(fs.readFileSync(todoFile(sessionId), "utf8")) as {
    items: Array<{ id: number; content: string; status: string; priority?: string }>
  }
  return parsed.items
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-todo-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  todo = await import("./todo.js")
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
  fs.rmSync(todoDir(), { recursive: true, force: true })
})

describe("todoCommand add/list", () => {
  it("reports an empty list", () => {
    expect(todo.todoCommand({ action: "list" })).toBe("(no todos)")
  })

  it("refuses to add without content", () => {
    expect(todo.todoCommand({ action: "add" })).toBe("Missing content")
    expect(fs.existsSync(todoDir())).toBe(false)
  })

  it("adds a pending todo with sequential ids", () => {
    expect(todo.todoCommand({ action: "add", content: "write tests" })).toBe("added #1: write tests")
    expect(todo.todoCommand({ action: "add", content: "run tests" })).toBe("added #2: run tests")

    const items = readTodos()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 1, content: "write tests", status: "pending" })
    expect(items[1].id).toBe(2)
    expect(items[0].priority).toBeUndefined()
  })

  it("stores priority and dependsOn when supplied", () => {
    todo.todoCommand({
      action: "add",
      content: "ship it",
      priority: "high",
      dependsOn: [1, 2],
    })
    const [item] = readTodos()
    expect(item.priority).toBe("high")
    expect((item as unknown as { dependsOn?: number[] }).dependsOn).toEqual([1, 2])
  })

  it("renders status checkboxes and priority in list output", () => {
    todo.todoCommand({ action: "add", content: "first", priority: "high" })
    todo.todoCommand({ action: "add", content: "second" })
    todo.todoCommand({ action: "add", content: "third" })
    todo.todoCommand({ action: "update", id: 2, status: "in_progress" })
    todo.todoCommand({ action: "update", id: 3, status: "completed" })

    expect(todo.todoCommand({ action: "list" })).toBe("[ ] #1 (high) first\n[*] #2 second\n[x] #3 third")
  })

  it("read behaves like list", () => {
    todo.todoCommand({ action: "add", content: "visible" })
    expect(todo.todoCommand({ action: "read" })).toBe("[ ] #1 visible")
  })
})

describe("todoCommand update", () => {
  beforeEach(() => {
    todo.todoCommand({ action: "add", content: "only todo" })
  })

  it("requires an id", () => {
    expect(todo.todoCommand({ action: "update" })).toBe("Missing id")
  })

  it("treats id 0 as missing (falsy guard)", () => {
    expect(todo.todoCommand({ action: "update", id: 0, status: "completed" })).toBe("Missing id")
  })

  it("reports an id that has no todo", () => {
    expect(todo.todoCommand({ action: "update", id: 42, status: "completed" })).toBe("No todo with id 42")
  })

  it("persists a status change and reports the resulting status", () => {
    expect(todo.todoCommand({ action: "update", id: 1, status: "completed" })).toBe("#1 -> completed")
    expect(readTodos()[0].status).toBe("completed")
  })

  it("changes priority without touching the status", () => {
    expect(todo.todoCommand({ action: "update", id: 1, priority: "low" })).toBe("#1 -> pending")
    expect(readTodos()[0]).toMatchObject({ status: "pending", priority: "low" })
  })
})

describe("todoCommand sessions and clear", () => {
  it("keeps each session's list in its own file", () => {
    todo.todoCommand({ action: "add", content: "for session a", sessionId: "sess-a" })
    todo.todoCommand({ action: "add", content: "for session b", sessionId: "sess-b" })

    expect(fs.existsSync(todoFile("sess-a"))).toBe(true)
    expect(fs.existsSync(todoFile("sess-b"))).toBe(true)
    expect(todo.todoCommand({ action: "list", sessionId: "sess-a" })).toBe("[ ] #1 for session a")
    expect(todo.todoCommand({ action: "list" })).toBe("(no todos)")
  })

  it("falls back to the global list for blank session ids", () => {
    todo.todoCommand({ action: "add", content: "global one", sessionId: "   " })
    expect(fs.existsSync(todoFile("global"))).toBe(true)
    expect(todo.todoCommand({ action: "list", sessionId: "" })).toBe("[ ] #1 global one")
  })

  it("clears only the requested session's todos", () => {
    todo.todoCommand({ action: "add", content: "keep", sessionId: "keep" })
    todo.todoCommand({ action: "add", content: "wipe", sessionId: "wipe" })

    expect(todo.todoCommand({ action: "clear", sessionId: "wipe" })).toBe("todos cleared")
    expect(todo.todoCommand({ action: "list", sessionId: "wipe" })).toBe("(no todos)")
    expect(todo.todoCommand({ action: "list", sessionId: "keep" })).toBe("[ ] #1 keep")
  })

  it("ids restart at 1 after a clear", () => {
    todo.todoCommand({ action: "add", content: "one" })
    todo.todoCommand({ action: "clear" })
    expect(todo.todoCommand({ action: "add", content: "again" })).toBe("added #1: again")
  })

  it("survives a corrupt list file by starting empty", () => {
    fs.mkdirSync(todoDir(), { recursive: true })
    fs.writeFileSync(todoFile("global"), "{ not json", "utf8")
    expect(todo.todoCommand({ action: "list" })).toBe("(no todos)")
    expect(todo.todoCommand({ action: "add", content: "fresh" })).toBe("added #1: fresh")
  })

  it("todoListForSession exposes the parsed items", () => {
    todo.todoCommand({ action: "add", content: "exposed" })
    const items = todo.todoListForSession()
    expect(items).toHaveLength(1)
    expect(items[0].content).toBe("exposed")
    expect(todo.todoListForSession("missing-session")).toEqual([])
  })

  it("reports an unknown action", () => {
    expect(todo.todoCommand({ action: "dance" as never })).toBe("Unknown todo action: dance")
  })
})

describe("todoCommand session id validation (round 12 attack)", () => {
  it("rejects ids that are not single path segments before touching disk", () => {
    for (const bad of ["../evil", "..\\evil", "/abs/path", "a/b"]) {
      expect(todo.todoCommand({ action: "list", sessionId: bad })).toBe(`Invalid session id: ${bad}`)
      expect(todo.todoCommand({ action: "add", content: "x", sessionId: bad })).toBe(`Invalid session id: ${bad}`)
      expect(todo.todoCommand({ action: "clear", sessionId: bad })).toBe(`Invalid session id: ${bad}`)
    }
    // A traversal like `../evil` used to resolve to a sibling of the todos
    // dir (~/.nemo/evil.json) — nothing at all may be written.
    expect(fs.existsSync(path.join(home, ".nemo", "evil.json"))).toBe(false)
    expect(fs.existsSync(path.join(home, "evil.json"))).toBe(false)
    expect(fs.existsSync(todoDir())).toBe(false)
  })

  it("cannot read or clear the user's config as if it were a todo list", () => {
    // `../config` resolves to ~/.nemo/config.json: the old code would
    // JSON.parse the real config (then crash on undefined .items) or, on
    // `clear`, overwrite it with {"items":[]} — wiping the configuration.
    fs.mkdirSync(path.join(home, ".nemo"), { recursive: true })
    const config = path.join(home, ".nemo", "config.json")
    fs.writeFileSync(config, JSON.stringify({ model: "keep-me" }), "utf8")

    expect(todo.todoCommand({ action: "list", sessionId: "../config" })).toBe("Invalid session id: ../config")
    expect(todo.todoCommand({ action: "clear", sessionId: "../config" })).toBe("Invalid session id: ../config")
    expect(todo.todoListForSession("../config")).toEqual([])
    expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({ model: "keep-me" })
  })

  it("todoListForSession returns nothing for an invalid id instead of escaping", () => {
    expect(todo.todoListForSession("a/b")).toEqual([])
    expect(todo.todoListForSession("..")).toEqual([])
    // Valid ids still work.
    todo.todoCommand({ action: "add", content: "real", sessionId: "sess-ok" })
    expect(todo.todoListForSession("sess-ok")).toHaveLength(1)
  })
})

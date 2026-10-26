/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The runtime `todo` / `todo_read` tools persist to
 * `~/.nemo/todos/<sessionId>.json`. `sessionId` reaches them through
 * `ToolContext`, which an embedding host or MCP server sets — so it sits outside
 * the trust boundary even though the local CLI never supplies anything hostile.
 *
 * `path.join(TODO_DIR, id + ".json")` used to take that id verbatim, so
 * `../../canary/secrets` resolved out of TODO_DIR: `todo_read` parsed whatever it
 * landed on and rendered it to the model, and the write path created or
 * truncated the target.
 *
 * The CLI's own copy (`apps/cli/src/commands/todo.ts`) already carried this
 * guard; this brings the runtime copy in line with it and with core's
 * `assertSessionId`. The traversal below is proved to resolve at a real canary
 * outside the todos directory, so these assertions fail if the guard is removed
 * rather than passing because the traversal happened to miss.
 *
 * `TODO_DIR` is a module-level constant built from `os.homedir()` at import
 * time, so overriding HOME afterwards is too late — hence the `os` mock. Node's
 * builtin namespaces are frozen, so this uses `vi.mock` rather than `vi.spyOn`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { HOME } = vi.hoisted(() => ({ HOME: { dir: "" } }))

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>()
  return { ...actual, default: actual, homedir: () => HOME.dir }
})

import { createTodoTool, loadTodoList } from "./todo.js"

/** Two levels up out of `<home>/.nemo/todos`, landing on the canary. */
const ESCAPE = "../../canary/secrets"
const HOSTILE = [ESCAPE, "../canary/secrets", "..\\canary\\secrets", "a/b", "/absolute", ".", "", "  ", "x.json"]

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "todo-guard-"))
  HOME.dir = tmp
  fs.mkdirSync(path.join(tmp, ".nemo", "todos"), { recursive: true })
  fs.mkdirSync(path.join(tmp, "canary"), { recursive: true })
  fs.writeFileSync(path.join(tmp, "canary", "secrets.json"), '{"items":[{"content":"leaked"}]}', "utf8")
})

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
})

function canaryIntact(): boolean {
  const f = path.join(tmp, "canary", "secrets.json")
  return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("leaked")
}

describe("todo sessionId cannot escape the todos directory", () => {
  it("the escape payload really does resolve onto the canary", () => {
    const dir = path.join(tmp, ".nemo", "todos")
    // Proves the premise: this is the file the traversal would reach.
    expect(path.join(dir, `${ESCAPE}.json`)).toBe(path.join(tmp, "canary", "secrets.json"))
    expect(canaryIntact()).toBe(true)
  })

  it("refuses to read a todo list from outside TODO_DIR", () => {
    expect(loadTodoList(ESCAPE).items).toEqual([])
    for (const id of HOSTILE) {
      expect(loadTodoList(id).items, `loadTodoList(${JSON.stringify(id)})`).toEqual([])
    }
    expect(canaryIntact()).toBe(true)
  })

  it("the write action cannot create or overwrite a file outside TODO_DIR", async () => {
    // This is the load-bearing case. `load()` wraps `todoFile` in a try/catch, so
    // a read cannot distinguish the guard from a parse failure — but `save()`
    // does not swallow it, and the write is what actually reaches the disk. The
    // canary holds a todo-list-shaped file so that, without the guard, the write
    // lands on it and its contents are replaced.
    const tool = createTodoTool()
    const target = path.join(tmp, "canary", "secrets.json")
    const before = fs.readFileSync(target, "utf8")

    const result = await tool.execute("t1", { action: "write", content: "pwned" }, undefined, undefined, {
      sessionId: ESCAPE,
    } as never)

    // Assert the damage first: without the guard the write lands on the canary
    // and replaces its contents, which is the clearest possible signal.
    expect(fs.readFileSync(target, "utf8"), "the canary was overwritten").toBe(before)
    // And the call must fail loudly rather than silently "succeeding" elsewhere.
    expect(result.isError).toBe(true)
    expect(canaryIntact()).toBe(true)
    expect(fs.existsSync(path.join(tmp, "canary", "secrets.json.tmp"))).toBe(false)
  })

  it("still serves the global list and ordinary session ids", () => {
    // The guard is not "deny everything": a missing id falls back to the global
    // list, and ordinary ids are untouched.
    expect(loadTodoList().items).toEqual([])
    expect(loadTodoList("sess-1").items).toEqual([])
    expect(loadTodoList("  sess-2  ").items).toEqual([])
  })
})

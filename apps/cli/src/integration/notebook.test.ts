/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookService } from "./notebook.js"

/**
 * Notebook/cell ids embed Date.now(), so the clock is frozen (and stepped
 * deliberately) to keep ids deterministic — same-millisecond collisions are
 * a documented quirk of the id scheme, not something these tests rely on.
 */
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

const stepClock = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms)
}

describe("NotebookService.create", () => {
  it("creates an empty notebook, marks it active, and indexes it", () => {
    const service = new NotebookService()
    const notebook = service.create("scratch")
    expect(notebook.id).toMatch(/^notebook-\d+$/)
    expect(notebook.name).toBe("scratch")
    expect(notebook.cells).toEqual([])
    expect(notebook.createdAt).toBeInstanceOf(Date)
    expect(notebook.updatedAt).toBeInstanceOf(Date)
    expect(service.getActive()).toBe(notebook)
    expect(service.get(notebook.id)).toBe(notebook)
  })

  it("ids are distinct once the clock moves", () => {
    const service = new NotebookService()
    const first = service.create("one")
    stepClock(1000)
    const second = service.create("two")
    expect(second.id).not.toBe(first.id)
    expect(service.list().map((notebook) => notebook.name)).toEqual(["one", "two"])
    expect(service.getActive()).toBe(second)
  })

  it("does not overwrite the first notebook when two are created in the same millisecond", () => {
    const service = new NotebookService()
    // No clock step: Date.now() is identical and the store is a Map keyed by
    // id, so before the disambiguation the second create() replaced the first.
    const first = service.create("one")
    const second = service.create("two")

    expect(second.id).not.toBe(first.id)
    expect(service.get(first.id)?.name).toBe("one")
    expect(service.get(second.id)?.name).toBe("two")
    expect(service.list()).toHaveLength(2)
  })

  it("get() misses on unknown ids", () => {
    expect(new NotebookService().get("notebook-999")).toBeUndefined()
  })
})

describe("NotebookService cells", () => {
  it("addCell appends code/markdown cells in order and bumps updatedAt", () => {
    const service = new NotebookService()
    const notebook = service.create("scratch")
    const code = service.addCell(notebook.id, "code", "print(1)")
    stepClock(5000)
    const markdown = service.addCell(notebook.id, "markdown", "# title")
    expect(code).toBeDefined()
    expect(markdown).toBeDefined()

    const stored = service.get(notebook.id)
    expect(stored?.cells.map((cell) => cell.type)).toEqual(["code", "markdown"])
    expect(stored?.cells[0]?.content).toBe("print(1)")
    expect(stored?.cells[1]?.content).toBe("# title")
    expect(stored?.cells.every((cell) => cell.output === undefined)).toBe(true)
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(notebook.createdAt.getTime())
  })

  it("keeps every cell even when two land in the same millisecond", () => {
    const service = new NotebookService()
    const notebook = service.create("scratch")
    // Clock deliberately NOT stepped: both cells share the Date.now() stamp.
    service.addCell(notebook.id, "code", "first")
    service.addCell(notebook.id, "code", "second")
    expect(service.get(notebook.id)?.cells.map((cell) => cell.content)).toEqual(["first", "second"])
  })

  it("addCell refuses unknown notebooks", () => {
    expect(new NotebookService().addCell("nope", "code", "x")).toBeUndefined()
  })

  it("executeCell stamps output and executedAt, leaving other cells alone", () => {
    const service = new NotebookService()
    const notebook = service.create("scratch")
    const first = service.addCell(notebook.id, "code", "1+1")!
    stepClock(2000)
    const second = service.addCell(notebook.id, "code", "2+2")!

    const executed = service.executeCell(notebook.id, first.id, "2")
    expect(executed?.id).toBe(first.id)
    expect(executed?.output).toBe("2")
    expect(executed?.executedAt).toBeInstanceOf(Date)

    const stored = service.get(notebook.id)
    expect(stored?.cells.find((cell) => cell.id === second.id)?.output).toBeUndefined()
    expect(stored?.cells.find((cell) => cell.id === second.id)?.executedAt).toBeUndefined()
  })

  it("executeCell refuses unknown notebooks and cells", () => {
    const service = new NotebookService()
    const notebook = service.create("scratch")
    expect(service.executeCell("nope", "cell-1", "out")).toBeUndefined()
    expect(service.executeCell(notebook.id, "cell-999", "out")).toBeUndefined()
  })
})

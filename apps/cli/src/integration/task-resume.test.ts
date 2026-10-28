/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { TaskResumeService, type TaskState } from "./task-resume.js"

/** The full task lifecycle: pending → running → {completed | failed | interrupted} → resume. */
const newService = (): TaskResumeService => new TaskResumeService()

describe("TaskResumeService lifecycle", () => {
  it("creates tasks as pending with their context and a start timestamp", () => {
    const service = newService()
    const task = service.create("t1", { cwd: "C:/repo" })
    expect(task.status).toBe("pending")
    expect(task.startedAt).toBeInstanceOf(Date)
    expect(task.context).toEqual({ cwd: "C:/repo" })
    expect(task.completedAt).toBeUndefined()
    expect(service.get("t1")).toEqual(task)
    // Context defaults to an empty record when omitted.
    expect(service.create("t2").context).toEqual({})
  })

  it("returns undefined for unknown tasks", () => {
    expect(newService().get("missing")).toBeUndefined()
  })

  it("start moves pending → running and rejects unknown ids", () => {
    const service = newService()
    service.create("t1")
    expect(service.start("t1")).toBe(true)
    expect(service.get("t1")?.status).toBe("running")
    expect(service.start("missing")).toBe(false)
  })

  it("complete stores the result and a completion timestamp", () => {
    const service = newService()
    service.create("t1")
    expect(service.complete("t1", { value: 42 })).toBe(true)
    const task = service.get("t1") as TaskState
    expect(task.status).toBe("completed")
    expect(task.result).toEqual({ value: 42 })
    expect(task.completedAt).toBeInstanceOf(Date)
    expect(service.complete("missing", "x")).toBe(false)
  })

  it("fail stores the error message", () => {
    const service = newService()
    service.create("t1")
    expect(service.fail("t1", "boom")).toBe(true)
    expect(service.get("t1")?.status).toBe("failed")
    expect(service.get("t1")?.error).toBe("boom")
    expect(service.fail("missing", "boom")).toBe(false)
  })

  it("interrupt marks the task interrupted", () => {
    const service = newService()
    service.create("t1")
    expect(service.interrupt("t1")).toBe(true)
    expect(service.get("t1")?.status).toBe("interrupted")
    expect(service.interrupt("missing")).toBe(false)
  })
})

describe("TaskResumeService resume rules", () => {
  it("only failed and interrupted tasks are resumable", () => {
    const service = newService()
    for (const [status, resumable] of [
      ["pending", false],
      ["running", false],
      ["completed", false],
      ["failed", true],
      ["interrupted", true],
    ] as const) {
      const id = `task-${status}`
      service.create(id)
      if (status !== "pending") {
        if (status === "running") service.start(id)
        if (status === "completed") service.complete(id, "ok")
        if (status === "failed") service.fail(id, "boom")
        if (status === "interrupted") service.interrupt(id)
      }
      expect(service.canResume(id), status).toBe(resumable)
    }
    expect(service.canResume("missing")).toBe(false)
  })

  it("resume flips a failed task back to running and clears its error", () => {
    const service = newService()
    service.create("t1", { attempt: 1 })
    service.fail("t1", "boom")
    const resumed = service.resume("t1")
    expect(resumed?.status).toBe("running")
    expect(resumed?.error).toBeUndefined()
    expect(resumed?.completedAt).toBeUndefined()
    expect(resumed?.context).toEqual({ attempt: 1 })
    // The same object is visible through get().
    expect(service.get("t1")).toEqual(resumed)
  })

  it("resume clears the completion timestamp of an interrupted task", () => {
    const service = newService()
    service.create("t1")
    service.start("t1")
    service.interrupt("t1")
    expect(service.get("t1")?.completedAt).toBeInstanceOf(Date)
    const resumed = service.resume("t1")
    expect(resumed?.status).toBe("running")
    expect(resumed?.completedAt).toBeUndefined()
  })

  it("resume refuses unknown or non-resumable tasks", () => {
    const service = newService()
    expect(service.resume("missing")).toBeUndefined()

    service.create("done")
    service.complete("done", "ok")
    expect(service.resume("done")).toBeUndefined()
    expect(service.get("done")?.status).toBe("completed")
  })
})

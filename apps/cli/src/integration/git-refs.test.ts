/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { GitRefsService, type GitRef } from "./git-refs.js"

/**
 * GitRefsService is the in-memory mirror a UI reads git state from — it
 * never shells out itself, so the contract to pin is set/replace/lookup
 * semantics plus the "no status yet" defaults.
 */
const branch = (name: string, commit: string, message?: string): GitRef => ({
  name,
  type: "branch",
  commit,
  message,
})

describe("GitRefsService refs", () => {
  it("stores refs by name and lists them in insertion order", () => {
    const service = new GitRefsService()
    service.setRefs([branch("main", "aaa"), branch("dev", "bbb"), { name: "v1", type: "tag", commit: "ccc" }])
    expect(service.listRefs().map((ref) => ref.name)).toEqual(["main", "dev", "v1"])
    expect(service.getRef("dev")).toEqual(branch("dev", "bbb"))
    expect(service.getRef("v1")?.type).toBe("tag")
    expect(service.getRef("main")?.message).toBeUndefined()
  })

  it("returns undefined for unknown refs", () => {
    const service = new GitRefsService()
    expect(service.getRef("nope")).toBeUndefined()
  })

  it("setRefs replaces the whole mirror instead of merging", () => {
    const service = new GitRefsService()
    service.setRefs([branch("main", "aaa")])
    service.setRefs([branch("feature", "bbb")])
    expect(service.listRefs().map((ref) => ref.name)).toEqual(["feature"])
    expect(service.getRef("main")).toBeUndefined()
  })

  it("keeps the last ref when names collide", () => {
    const service = new GitRefsService()
    service.setRefs([branch("main", "old"), branch("main", "new")])
    expect(service.listRefs()).toHaveLength(1)
    expect(service.getRef("main")?.commit).toBe("new")
  })
})

describe("GitRefsService status", () => {
  it("reports no branch and a clean tree before a status arrives", () => {
    const service = new GitRefsService()
    expect(service.getStatus()).toBeUndefined()
    expect(service.getCurrentBranch()).toBeUndefined()
    expect(service.isDirty()).toBe(false)
  })

  it("exposes the branch and dirtiness of the last status set", () => {
    const service = new GitRefsService()
    service.setStatus({
      branch: "main",
      ahead: 2,
      behind: 0,
      dirty: true,
      staged: 1,
      modified: 3,
      added: 0,
      deleted: 0,
    })
    expect(service.getCurrentBranch()).toBe("main")
    expect(service.isDirty()).toBe(true)
    expect(service.getStatus()?.ahead).toBe(2)
    expect(service.getStatus()?.modified).toBe(3)
  })

  it("a clean status flips isDirty back to false", () => {
    const service = new GitRefsService()
    service.setStatus({
      branch: "dev",
      ahead: 0,
      behind: 1,
      dirty: false,
      staged: 0,
      modified: 0,
      added: 0,
      deleted: 0,
    })
    expect(service.isDirty()).toBe(false)
    expect(service.getCurrentBranch()).toBe("dev")
  })
})

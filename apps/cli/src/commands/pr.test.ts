/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { prCheckout, prCommand, prLink, prStatus, prUnlink, readPrLink, type GhRunner } from "./pr.js"

let cwd = ""

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true })
  cwd = ""
})

function tempCwd(): string {
  cwd = mkdtempSync(join(tmpdir(), "nemo-pr-"))
  return cwd
}

const okRunner: GhRunner = async (args) => `gh ${args.join(" ")}`

describe("prCheckout", () => {
  it("checks out numeric PRs through gh", async () => {
    expect(await prCheckout("12", "/repo", okRunner)).toBe("gh pr checkout 12")
  })

  it("rejects non-numeric input without calling gh", async () => {
    let called = 0
    const out = await prCheckout("abc", "/repo", async () => {
      called += 1
      return ""
    })

    expect(out).toContain("Error: PR number must be numeric")
    expect(called).toBe(0)
  })

  it("reports gh failures honestly", async () => {
    const out = await prCheckout("12", "/repo", async () => Promise.reject(new Error("auth failed")))

    expect(out).toBe("Error: auth failed")
  })
})

describe("pr link/unlink", () => {
  it("round-trips a link through .nemo/pr.json", () => {
    const dir = tempCwd()

    expect(prLink("https://github.com/o/r/pull/1", dir)).toBe("Linked https://github.com/o/r/pull/1")
    expect(readPrLink(dir)?.url).toBe("https://github.com/o/r/pull/1")
    expect(JSON.parse(readFileSync(join(dir, ".nemo", "pr.json"), "utf8")).url).toBe(
      "https://github.com/o/r/pull/1",
    )
    expect(prUnlink(dir)).toBe("Unlinked PR")
    expect(readPrLink(dir)).toBeNull()
    expect(existsSync(join(dir, ".nemo", "pr.json"))).toBe(false)
  })

  it("rejects empty urls and reports a missing link", () => {
    const dir = tempCwd()

    expect(prLink("   ", dir)).toContain("Error")
    expect(prUnlink(dir)).toBe("No PR linked")
    expect(readPrLink(dir)).toBeNull()
  })
})

describe("prStatus", () => {
  it("shows the linked PR plus gh output", async () => {
    const dir = tempCwd()
    prLink("https://github.com/o/r/pull/3", dir)

    const out = await prStatus(dir, okRunner)

    expect(out).toContain("Linked PR: https://github.com/o/r/pull/3")
    expect(out).toContain("gh pr view")
  })

  it("falls back to gh pr status with no link", async () => {
    const dir = tempCwd()

    const out = await prStatus(dir, okRunner)

    expect(out).toContain("Linked PR: none")
    expect(out).toContain("gh pr status")
  })

  it("keeps the link line when gh fails", async () => {
    const dir = tempCwd()

    const out = await prStatus(dir, async () => Promise.reject(new Error("no auth")))

    expect(out).toContain("Linked PR: none")
    expect(out).toContain("gh status failed: no auth")
  })
})

describe("prCommand", () => {
  it("dispatches every action and rejects unknown ones", async () => {
    const dir = tempCwd()

    expect(await prCommand("checkout", undefined, dir, okRunner)).toContain("Usage:")
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
    expect(await prCommand("link", undefined, dir, okRunner)).toContain("Usage:")
    expect(await prCommand("link", "https://x/pull/9", dir, okRunner)).toContain("Linked")
    expect(await prCommand("status", undefined, dir, okRunner)).toContain("Linked PR:")
    expect(await prCommand("unlink", undefined, dir, okRunner)).toBe("Unlinked PR")
    expect(await prCommand("merge", undefined, dir, okRunner)).toContain("Unknown pr action")
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
  })

  it("exits 1 on gh failures and bad numbers", async () => {
    const dir = tempCwd()

    expect(await prCommand("checkout", "abc", dir, okRunner)).toContain("Error: PR number must be numeric")
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    expect(await prCommand("checkout", "12", dir, async () => Promise.reject(new Error("nope")))).toContain(
      "Error: nope",
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})

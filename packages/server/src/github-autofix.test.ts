/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi, afterEach } from "vitest"
import {
  AutofixLedger,
  autofixBranch,
  autofixKey,
  autofixTick,
  listLabeledIssues,
  parseAutofixRepos,
  type FetchJson,
} from "./github-autofix.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

function tmpLedger(): AutofixLedger {
  return new AutofixLedger(join(mkdtempSync(join(tmpdir(), "gh-af-")), "ledger.json"))
}

describe("parseAutofixRepos", () => {
  it("parses allowlists, keeps wildcards, drops garbage", () => {
    expect(parseAutofixRepos(undefined)).toEqual([])
    expect(parseAutofixRepos("")).toEqual([])
    expect(parseAutofixRepos("o/a, o/b ,nope,https://x")).toEqual(["o/a", "o/b"])
    expect(parseAutofixRepos("*")).toEqual(["*"])
    expect(parseAutofixRepos("o/a,*")).toEqual(["o/a", "*"])
  })

  it("keys and branches are stable", () => {
    expect(autofixKey("O/A", 3)).toBe("o/a#3")
    expect(autofixBranch(3)).toBe("trayambak/issue-3")
  })
})

describe("AutofixLedger", () => {
  it("marks once and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-af-persist-"))
    const file = join(dir, "ledger.json")
    const a = new AutofixLedger(file)
    expect(a.has("o/a", 1)).toBe(false)
    a.mark("o/a", 1, "https://github.com/o/a/pull/9")
    expect(a.has("o/a", 1)).toBe(true)
    expect(new AutofixLedger(file).has("o/a", 1)).toBe(true)
  })

  it("tracks greetings separately from fixes", () => {
    const ledger = tmpLedger()
    expect(ledger.greeted("o/a", 5)).toBe(false)
    ledger.markGreeted("o/a", 5)
    expect(ledger.greeted("o/a", 5)).toBe(true)
    expect(ledger.has("o/a", 5)).toBe(false)
  })
})

describe("listLabeledIssues", () => {
  it("keeps issues, drops PRs and non-200s", async () => {
    const fetchJson: FetchJson = async (path) => {
      expect(path).toContain("labels=trayambak")
      return {
        status: 200,
        json: [{ number: 1, title: "fix me" }, { number: 2, title: "a pr", pull_request: {} }, "garbage"],
      }
    }
    expect(await listLabeledIssues(fetchJson, "tok", "o/a", "trayambak")).toEqual([
      { repo: "o/a", number: 1, title: "fix me" },
    ])
    const dead: FetchJson = async () => ({ status: 403, json: null })
    expect(await listLabeledIssues(dead, "tok", "o/a", "trayambak")).toEqual([])
  })
})

describe("autofixTick", () => {
  it("runs the oldest unhandled issue once, then skips it forever", async () => {
    const ledger = tmpLedger()
    const fetchJson: FetchJson = async () => ({
      status: 200,
      json: [
        { number: 1, title: "first" },
        { number: 2, title: "second" },
      ],
    })
    const runs: string[] = []
    const deps = {
      repos: ["o/a"],
      label: "trayambak",
      ledger,
      installationIdFor: async () => 111,
      tokenFor: async () => "tok",
      fetchJson,
      runJob: async (repo: string, number: number, task: string) => {
        runs.push(`${repo}#${number}:${task}`)
        return "opened https://github.com/o/a/pull/9 for you"
      },
    }
    const first = await autofixTick(deps)
    expect(first.ran).toHaveLength(1)
    expect(first.ran[0]).toMatchObject({ repo: "o/a", number: 1, prUrl: "https://github.com/o/a/pull/9" })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain("trayambak/issue-1")
    // Second tick: #1 ledgered, runs #2. Third: nothing left to run.
    const second = await autofixTick(deps)
    expect(second.ran[0]?.number).toBe(2)
    const third = await autofixTick(deps)
    expect(third.ran).toHaveLength(0)
    expect(third.checked).toBe(2)
  })

  it("stays idle without repos and survives credential failures", async () => {
    const ledger = tmpLedger()
    let jobs = 0
    const idle = await autofixTick({
      repos: [],
      label: "trayambak",
      ledger,
      installationIdFor: async () => 0,
      tokenFor: async () => "",
      fetchJson: async () => ({ status: 200, json: [] }),
      runJob: async () => {
        jobs++
        return ""
      },
    })
    expect(idle).toMatchObject({ checked: 0, ran: [] })
    const broken = await autofixTick({
      repos: ["o/a"],
      label: "trayambak",
      ledger,
      installationIdFor: async () => {
        throw new Error("nope")
      },
      tokenFor: async () => "",
      fetchJson: async () => ({ status: 200, json: [] }),
      runJob: async () => {
        jobs++
        return ""
      },
    })
    expect(broken.ran).toHaveLength(0)
    expect(jobs).toBe(0)
  })
})

describe("triage pass", () => {
  const openIssues: FetchJson = async (path) => {
    if (path.includes("labels=")) return { status: 200, json: [] }
    return {
      status: 200,
      json: [
        { number: 10, title: "new one" },
        { number: 11, title: "another" },
        { number: 12, title: "a pr", pull_request: {} },
      ],
    }
  }
  const baseDeps = (ledger: AutofixLedger, posted: string[]) => ({
    repos: ["o/a"],
    label: "trayambak",
    ledger,
    installationIdFor: async () => 111,
    tokenFor: async () => "tok",
    fetchJson: openIssues,
    runJob: async () => "",
    postComment: async (repo: string, number: number, body: string) => {
      posted.push(`${repo}#${number}:${body.slice(0, 20)}`)
      return true
    },
  })

  it("greets every unseen issue once, capped per tick", async () => {
    const ledger = tmpLedger()
    const posted: string[] = []
    const first = await autofixTick({ ...baseDeps(ledger, posted), maxTriagePerTick: 1 })
    expect(first.triaged).toEqual(["o/a#10"])
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain("I can fix this")
    const second = await autofixTick({ ...baseDeps(ledger, posted), maxTriagePerTick: 10 })
    expect(second.triaged).toEqual(["o/a#11"])
    const third = await autofixTick(baseDeps(ledger, posted))
    expect(third.triaged).toEqual([])
  })

  it("failed posts retry next tick; empty text disables triage", async () => {
    const ledger = tmpLedger()
    let fail = true
    const posted: string[] = []
    const deps = {
      ...baseDeps(ledger, posted),
      postComment: async (repo: string, number: number) => {
        if (fail) return false
        posted.push(`${repo}#${number}`)
        return true
      },
    }
    expect((await autofixTick(deps)).triaged).toEqual([])
    expect(ledger.greeted("o/a", 10)).toBe(false)
    fail = false
    expect((await autofixTick(deps)).triaged).toEqual(["o/a#10", "o/a#11"])
    const off = await autofixTick({ ...baseDeps(tmpLedger(), []), triageComment: "" })
    expect(off.triaged).toEqual([])
  })

  it("expands wildcards to installed repos", async () => {
    const ledger = tmpLedger()
    const posted: string[] = []
    const r = await autofixTick({
      ...baseDeps(ledger, posted),
      repos: ["*"],
      listAllRepos: async () => ["o/a", "o/b"],
    })
    expect(r.triaged).toEqual(["o/a#10", "o/a#11", "o/b#10", "o/b#11"])
  })
})

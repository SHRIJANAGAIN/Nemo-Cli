/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as IntegrationModule from "./index.js"
import type { WatcherEvent } from "./watcher.js"

/**
 * index.ts is the integration barrel. It also pulls in ./plan transitively,
 * and plan.ts resolves its storage root from os.homedir() AT MODULE LOAD, so
 * the temp home is installed before the dynamic import in beforeAll and the
 * real ~/.trayambak is never touched. `import type` above is erased, so it
 * cannot pull the module in early.
 *
 * Namespace/class/singleton wiring is checked structurally ONCE per namespace
 * (a broken re-export must fail somewhere), then every claim below it is a
 * behavior exercised through the barrel itself.
 */

let mod: typeof IntegrationModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const NAMESPACES: readonly string[] = [
  "TrayambakSandbox",
  "TrayambakIndexing",
  "TrayambakPresence",
  "TrayambakBoard",
  "TrayambakPlan",
  "TrayambakNotebook",
  "TrayambakWatcher",
  "TrayambakGitRefs",
  "TrayambakProjectId",
  "TrayambakTaskResume",
  "TrayambakTextStream",
  "TrayambakParentWatchdog",
]

const SERVICE_PAIRS: ReadonlyArray<{ readonly ns: string; readonly cls: string; readonly singleton: string }> = [
  { ns: "TrayambakSandbox", cls: "SandboxService", singleton: "sandboxService" },
  { ns: "TrayambakIndexing", cls: "IndexingService", singleton: "indexingService" },
  { ns: "TrayambakPresence", cls: "PresenceService", singleton: "presenceService" },
  { ns: "TrayambakBoard", cls: "BoardService", singleton: "boardService" },
  { ns: "TrayambakPlan", cls: "PlanService", singleton: "planService" },
  { ns: "TrayambakNotebook", cls: "NotebookService", singleton: "notebookService" },
  { ns: "TrayambakWatcher", cls: "WatcherService", singleton: "watcherService" },
  { ns: "TrayambakGitRefs", cls: "GitRefsService", singleton: "gitRefsService" },
  { ns: "TrayambakProjectId", cls: "ProjectIdService", singleton: "projectIdService" },
  { ns: "TrayambakTaskResume", cls: "TaskResumeService", singleton: "taskResumeService" },
  { ns: "TrayambakTextStream", cls: "TextStreamService", singleton: "textStreamService" },
  { ns: "TrayambakParentWatchdog", cls: "ParentWatchdogService", singleton: "parentWatchdogService" },
]

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-integration-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  mod = await import("./index.js")
})

afterAll(() => {
  // Restored only here: plan storage resolves its path per call (not at
  // import), so the stub must stay installed while the tests run or they would
  // read/write the developer's real ~/.trayambak.
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("integration barrel wiring", () => {
  it("exposes every integration namespace", () => {
    const namespaces = mod as unknown as Record<string, unknown>
    for (const name of NAMESPACES) {
      expect(namespaces[name]).toBeTruthy()
    }
  })

  it("wires each namespace's exported singleton to its exported class", () => {
    const namespaces = mod as unknown as Record<string, Record<string, unknown>>
    for (const pair of SERVICE_PAIRS) {
      const ns = namespaces[pair.ns]
      const cls = ns?.[pair.cls]
      const singleton = ns?.[pair.singleton]
      expect(typeof cls).toBe("function")
      expect(singleton).toBeInstanceOf(cls as new () => unknown)
    }
  })

  it("re-exports itself, so the nested index namespace shares the same services", () => {
    expect(mod.TrayambakIntegrationIndex.TrayambakSandbox.sandboxService).toBe(mod.TrayambakSandbox.sandboxService)
    expect(mod.TrayambakIntegrationIndex.TrayambakPlan.getPlansFilePath()).toBe(mod.TrayambakPlan.getPlansFilePath())
  })
})

describe("services behave through the barrel", () => {
  it("sandbox allows every operation until a capability is disabled, then blocks it", () => {
    const sandbox = new mod.TrayambakSandbox.SandboxService()
    expect(sandbox.getConfig().enabled).toBe(true)
    expect(sandbox.allow("network")).toBe(true)
    expect(() => sandbox.assert("network")).not.toThrow()

    sandbox.setConfig({ network: false })
    expect(sandbox.allow("network")).toBe(false)
    expect(sandbox.allow("filesystem")).toBe(true)
    expect(() => sandbox.assert("network")).toThrow("Sandbox blocked: network")

    sandbox.setConfig({ enabled: false })
    expect(sandbox.allow("network")).toBe(true)
    expect(() => sandbox.assert("network")).not.toThrow()
  })

  it("text-stream splits into 100-character chunks, buffers them, and honours the buffer bound", () => {
    const stream = new mod.TrayambakTextStream.TextStreamService()
    const chunks: string[] = []
    let completed = ""
    stream.stream("x".repeat(250), {
      onChunk: (chunk) => chunks.push(chunk),
      onComplete: (full) => {
        completed = full
      },
    })

    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50])
    expect(completed).toBe("x".repeat(250))
    expect(stream.getBuffered()).toBe("x".repeat(250))

    stream.clear()
    expect(stream.getBuffered()).toBe("")

    stream.setBufferSize(1)
    stream.stream("y".repeat(250))
    expect(stream.getBuffered()).toBe("y".repeat(50))
  })

  it("git-refs deduplicates refs by name and reports branch status", () => {
    const git = new mod.TrayambakGitRefs.GitRefsService()
    git.setRefs([
      { name: "main", type: "branch", commit: "aaa" },
      { name: "feature", type: "branch", commit: "bbb" },
      { name: "main", type: "branch", commit: "ccc" },
    ])

    expect(git.listRefs().map((r) => r.name)).toEqual(["main", "feature"])
    expect(git.getRef("main")?.commit).toBe("ccc")
    expect(git.getRef("nope")).toBeUndefined()
    expect(git.getStatus()).toBeUndefined()
    expect(git.isDirty()).toBe(false)

    git.setStatus({ branch: "feature", ahead: 1, behind: 0, dirty: true, staged: 2, modified: 3, added: 0, deleted: 1 })
    expect(git.getCurrentBranch()).toBe("feature")
    expect(git.isDirty()).toBe(true)
  })

  it("board delivers messages to their recipient or to everyone, and tracks participants", () => {
    const board = new mod.TrayambakBoard.BoardService()
    board.post({ author: "agent", content: "hello user", recipient: "user" })
    board.post({ author: "user", content: "hi agent", recipient: "agent" })
    board.post({ author: "agent", content: "broadcast" })

    expect(board.read("user").map((m) => m.content)).toEqual(["hello user", "broadcast"])
    expect(board.read("agent").map((m) => m.content)).toEqual(["hi agent", "broadcast"])
    expect(board.read("ALL").map((m) => m.content)).toEqual(["hello user", "hi agent", "broadcast"])
    expect(board.read().map((m) => m.content)).toEqual(["broadcast"])
    expect(board.getParticipants().sort()).toEqual(["agent", "local", "user"])

    board.clear()
    expect(board.read("ALL")).toEqual([])
    expect(board.getParticipants().sort()).toEqual(["agent", "local", "user"])
  })

  it("presence notifies subscribers until they unsubscribe", () => {
    const presence = new mod.TrayambakPresence.PresenceService()
    const seen: string[] = []
    const unsubscribe = presence.subscribe((state) => seen.push(state.status))

    presence.setStatus("away")
    expect(seen).toEqual(["away"])
    expect(presence.getState().status).toBe("away")
    expect(presence.getState().lastSeen).toBeInstanceOf(Date)

    unsubscribe()
    presence.setStatus("busy")
    expect(seen).toEqual(["away"])
  })

  it("watcher announces watch/unwatch without touching the filesystem", () => {
    const watcher = new mod.TrayambakWatcher.WatcherService()
    const lifecycle: string[] = []
    const changes: WatcherEvent[] = []
    watcher.on("start", () => lifecycle.push("start"))
    watcher.on("stop", () => lifecycle.push("stop"))
    watcher.on("change", (event: WatcherEvent) => changes.push(event))

    const target = path.join(home, "project")
    watcher.watch(target)
    expect(watcher.getWatchedPaths()).toEqual([target])

    watcher.emitEvent({ type: "add", path: target, timestamp: new Date() })
    expect(changes.map((c) => c.type)).toEqual(["add"])

    expect(watcher.unwatch(target)).toBe(true)
    expect(watcher.unwatch(target)).toBe(false)
    expect(lifecycle).toEqual(["start", "stop"])
    watcher.close()
    expect(watcher.getWatchedPaths()).toEqual([])
  })

  it("indexing runs to completion and records the run in its state", async () => {
    const indexing = new mod.TrayambakIndexing.IndexingService()
    expect(indexing.getState().status).toBe("idle")

    await indexing.run()

    const state = indexing.getState()
    expect(state.status).toBe("idle")
    expect(state.progress).toBe(100)
    expect(state.lastRun).toBeInstanceOf(Date)
    expect(state.error).toBeUndefined()
  })

  it("plan storage resolves under the barrel's home directory", () => {
    expect(mod.TrayambakPlan.getPlansFilePath()).toBe(path.join(home, ".trayambak", "plans.json"))
    expect(new mod.TrayambakPlan.PlanService().list()).toEqual([])
  })

  it("parent watchdog starts, observes a live parent, and stops", () => {
    const watchdog = new mod.TrayambakParentWatchdog.ParentWatchdogService()
    try {
      watchdog.start(process.pid)
      expect(watchdog.getState()?.parentPid).toBe(process.pid)
      expect(watchdog.getState()?.alive).toBe(true)
    } finally {
      watchdog.stop()
    }
    expect(watchdog.getState()).toBeDefined()
  })
})

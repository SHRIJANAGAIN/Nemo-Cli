/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Thread store integrity (#68, #69):
 *   - thread ids cannot escape the store directory,
 *   - entries are written atomically and verified against their stored
 *     checksum on read, with corrupt entries quarantined byte-for-byte,
 *   - stray files never break listing, and close() never rewrites a
 *     stale cache over a newer write.
 *
 * Every case runs against a throwaway store under the OS temp dir — the
 * default store is `~/.trayambak/threads`, i.e. the user's real history.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ThreadSource, ThreadStatus, resetThreadStore, type ThreadStore } from "./session_store.js"

let dir: string
let store: ThreadStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trayambak-threads-"))
  store = resetThreadStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("thread id validation (#68)", () => {
  it("rejects ids that could escape the store directory", () => {
    expect(() =>
      store.createThread("../../escape", { source: ThreadSource.User, status: ThreadStatus.Active }),
    ).toThrow(/Invalid thread id/)
    expect(() => store.readThread("a/b")).toThrow(/Invalid thread id/)
    expect(() => store.deleteThread("..\\..\\victim")).toThrow(/Invalid thread id/)
    expect(() => store.forkThread("ok", "nested/id")).toThrow(/Invalid thread id/)
    // nothing was created or removed outside: the store dir holds no entries
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([])
    expect(existsSync(join(dir, "..", "escape.json"))).toBe(false)
  })

  it("still round-trips normal ids through the full lifecycle", () => {
    store.createThread("task-1", { source: ThreadSource.User, status: ThreadStatus.Active })
    store.addMessages("task-1", [{ role: "user", content: "hi", timestamp: Date.now() }])
    expect(store.readThread("task-1")?.messages).toHaveLength(1)
    store.archiveThread("task-1")
    expect(store.getActiveThreads()).toHaveLength(0)
    const forked = store.forkThread("task-1", "task-1-fork")
    expect(forked?.metadata.forkedFrom).toBe("task-1")
    expect(store.getThreadCount()).toBe(2)
    expect(store.deleteThread("task-1-fork")).toBe(true)
    expect(store.getThreadCount()).toBe(1)
  })

  it("ignores stray files in the store instead of failing listing", () => {
    store.createThread("good", { source: ThreadSource.User, status: ThreadStatus.Active })
    writeFileSync(
      join(dir, "stray file.json"),
      JSON.stringify({
        metadata: { id: "stray file", source: "user", status: "active", createdAt: 1, updatedAt: 1 },
        messages: [],
        checksum: "checksum_x",
      }),
      "utf8",
    )
    const all = store.getAllThreads()
    expect(all.map((t) => t.metadata.id)).toEqual(["good"])
  })
})

describe("entry integrity (#69)", () => {
  it("quarantines an unparseable entry with its bytes intact", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    const path = join(dir, "t1.json")
    writeFileSync(path, "{ not json", "utf8")
    const fresh = resetThreadStore(dir) // new handle — no cache to mask the disk
    expect(fresh.readThread("t1")).toBeNull()
    const backups = readdirSync(dir).filter((f) => f.startsWith("t1.json.corrupt"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("{ not json")
    // a later create with the same id must not overwrite the evidence
    fresh.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("{ not json")
  })

  it("detects tampered messages via the stored checksum", () => {
    store.createThread("t2", { source: ThreadSource.User, status: ThreadStatus.Active })
    store.addMessages("t2", [{ role: "user", content: "original", timestamp: 1 }])
    const path = join(dir, "t2.json")
    const entry = JSON.parse(readFileSync(path, "utf8")) as {
      messages: Array<{ content: string }>
      checksum: string
    }
    entry.messages[0]!.content = "tampered" // still valid JSON — only the checksum catches it
    writeFileSync(path, JSON.stringify(entry), "utf8")
    const fresh = resetThreadStore(dir)
    expect(fresh.readThread("t2")).toBeNull()
    expect(readdirSync(dir).some((f) => f.startsWith("t2.json.corrupt"))).toBe(true)
  })

  it("accepts legacy entries that predate the checksum field", () => {
    writeFileSync(
      join(dir, "legacy.json"),
      JSON.stringify({
        metadata: { id: "legacy", source: "user", status: "active", createdAt: 1, updatedAt: 1 },
        messages: [],
      }),
      "utf8",
    )
    expect(store.readThread("legacy")?.metadata.id).toBe("legacy")
  })

  it("writes entries atomically — no tmp litter after a save", () => {
    store.createThread("t3", { source: ThreadSource.User, status: ThreadStatus.Active })
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([])
    const entry = JSON.parse(readFileSync(join(dir, "t3.json"), "utf8")) as { checksum?: string }
    expect(entry.checksum).toMatch(/^checksum_/)
  })

  it("close() does not clobber another handle's newer write", () => {
    store.createThread("t4", { source: ThreadSource.User, status: ThreadStatus.Active })
    const b = resetThreadStore(dir) // second handle over the same directory
    b.addMessages("t4", [{ role: "assistant", content: "from-b", timestamp: 2 }])
    store.close() // old code re-persisted store's stale cache, erasing from-b
    const c = resetThreadStore(dir)
    expect(c.readThread("t4")?.messages.some((m) => m.content === "from-b")).toBe(true)
  })
})

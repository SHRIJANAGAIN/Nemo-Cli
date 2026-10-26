/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { CheckpointStore } from "./checkpoints.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cp-"))
  fs.writeFileSync(path.join(dir, "a.txt"), "original A")
  fs.writeFileSync(path.join(dir, "b.txt"), "original B")
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8")
}

describe("CheckpointStore", () => {
  it("undo reverts modified files", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    fs.writeFileSync(path.join(dir, "a.txt"), "MODIFIED")
    const result = store.undo()
    expect(result.ok).toBe(true)
    expect(read("a.txt")).toBe("original A")
  })

  it("undo deletes files created after the checkpoint", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    fs.writeFileSync(path.join(dir, "new-file.ts"), "created later")
    expect(fs.existsSync(path.join(dir, "new-file.ts"))).toBe(true)
    store.undo()
    expect(fs.existsSync(path.join(dir, "new-file.ts"))).toBe(false)
  })

  it("undo restores files deleted after the checkpoint", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    fs.rmSync(path.join(dir, "b.txt"))
    store.undo()
    expect(read("b.txt")).toBe("original B")
  })

  it("undo removes directories that only contain new files", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    fs.mkdirSync(path.join(dir, "brand-new-dir"))
    fs.writeFileSync(path.join(dir, "brand-new-dir", "x.txt"), "x")
    store.undo()
    expect(fs.existsSync(path.join(dir, "brand-new-dir"))).toBe(false)
  })

  it("redo re-applies what undo reverted", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    fs.writeFileSync(path.join(dir, "a.txt"), "MODIFIED")
    fs.writeFileSync(path.join(dir, "extra.txt"), "extra")

    store.undo()
    expect(read("a.txt")).toBe("original A")
    expect(fs.existsSync(path.join(dir, "extra.txt"))).toBe(false)

    const redo = store.redo()
    expect(redo.ok).toBe(true)
    expect(read("a.txt")).toBe("MODIFIED")
    expect(read("extra.txt")).toBe("extra")
  })

  it("undo with nothing to undo fails gracefully", () => {
    const store = new CheckpointStore(dir)
    expect(store.undo().ok).toBe(false)
    expect(store.redo().ok).toBe(false)
  })

  it("undo on an unchanged workspace is a clean no-op", () => {
    const store = new CheckpointStore(dir)
    store.capture("before turn")
    const result = store.undo()
    expect(result.ok).toBe(true)
    expect(read("a.txt")).toBe("original A")
    // The no-op redo point must not linger.
    expect(store.canRedo()).toBe(false)
  })

  it("skips node_modules and .nemo entirely", () => {
    const store = new CheckpointStore(dir)
    fs.mkdirSync(path.join(dir, "node_modules"))
    fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "junk")
    store.capture("before turn")
    fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "changed")
    fs.writeFileSync(path.join(dir, "node_modules", "new.js"), "new")
    store.undo()
    // Untracked dirs are neither captured nor touched by restore.
    expect(fs.readFileSync(path.join(dir, "node_modules", "junk.js"), "utf8")).toBe("changed")
    expect(fs.existsSync(path.join(dir, "node_modules", "new.js"))).toBe(true)
  })

  it("a new capture after undo invalidates redo", () => {
    const store = new CheckpointStore(dir)
    store.capture("cp1")
    fs.writeFileSync(path.join(dir, "a.txt"), "modified")
    store.undo()
    expect(store.canRedo()).toBe(true)
    store.capture("cp2")
    expect(store.canRedo()).toBe(false)
  })

  it("stacks survive a store restart (persisted to disk)", () => {
    {
      const store = new CheckpointStore(dir)
      store.capture("cp1")
      fs.writeFileSync(path.join(dir, "a.txt"), "modified")
    }
    const reopened = new CheckpointStore(dir)
    expect(reopened.canUndo()).toBe(true)
    const result = reopened.undo()
    expect(result.ok).toBe(true)
    expect(read("a.txt")).toBe("original A")
  })

  it("retention trims the oldest checkpoints", () => {
    const store = new CheckpointStore(dir, { maxCheckpoints: 3 })
    for (let i = 0; i < 6; i++) {
      store.capture(`cp${i}`)
      fs.writeFileSync(path.join(dir, "a.txt"), `state ${i}`)
    }
    const listed = store.list()
    expect(listed.length).toBeLessThanOrEqual(3)
  })

  it("captureAsync yields to the event loop (turn-start never freezes the UI)", async () => {
    // The sync capture() used to walk + hash + copy the whole workspace in
    // one blocking pass on every turn — ~8s on a mid-size repo — freezing
    // the TUI right after Enter with composer cleared and no bubble, which
    // read exactly like "my message never sent". captureAsync must yield
    // (≥2 yields with 130+ files: at i=63 and i=127) so timers keep firing.
    fs.mkdirSync(path.join(dir, "many"))
    for (let i = 0; i < 130; i++) {
      fs.writeFileSync(path.join(dir, "many", `f${i}.txt`), `file ${i}`)
    }
    const store = new CheckpointStore(dir)
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)
    const meta = await store.captureAsync("async turn")
    expect(meta.id).toBeTruthy()
    expect(store.canUndo()).toBe(true)
    // A macrotask scheduled during the snapshot must have run before the
    // snapshot resolved — proof the walk yielded instead of blocking.
    expect(timerFired).toBe(true)
    // Explicit timeout: this does real fs work (130 files) and under
    // full-suite parallel worker contention it gets starved past vitest's
    // 5s default (measured 5.8-6.3s in suite runs vs 322ms isolated).
    // The assertion is about event-loop yielding, not wall-clock speed —
    // headroom here, same precedent as healing's 30s.
  }, 30_000)

  it("captureAsync yields an identical checkpoint to sync capture", async () => {
    const syncMeta = new CheckpointStore(dir).capture("turn")
    const asyncMeta = await new CheckpointStore(dir).captureAsync("turn")
    expect(asyncMeta.stateHash).toBe(syncMeta.stateHash)
    expect(asyncMeta.fileCount).toBe(syncMeta.fileCount)
  })

  it("undo restores files after captureAsync (same stack, async path)", async () => {
    const store = new CheckpointStore(dir)
    await store.captureAsync("before turn")
    fs.writeFileSync(path.join(dir, "a.txt"), "MODIFIED")
    const result = store.undo()
    expect(result.ok).toBe(true)
    expect(read("a.txt")).toBe("original A")
  })

  it("refuses home/root workspaces instead of snapshotting the machine", () => {
    const store = new CheckpointStore(os.homedir())
    expect(store.isDisabled()).toBe(true)
    const meta = store.capture("x")
    expect(meta.fileCount).toBe(0)
    expect(store.undo().ok).toBe(false)
    expect(store.redo().ok).toBe(false)
  })

  it("abandons oversize snapshots instead of OOMing", async () => {
    fs.mkdirSync(path.join(dir, "big"))
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(path.join(dir, "big", `f${i}.txt`), "x")
    }
    const store = new CheckpointStore(dir)
    await expect(store.captureAsync("oversize", { budgetMs: 60_000 })).rejects.toThrow(/too large/)
    expect(store.canUndo()).toBe(false)
    expect(() => store.capture("oversize")).toThrow(/too large/)
  }, 90_000)

  it("prune deletes everything and reports bytes", () => {
    const store = new CheckpointStore(dir)
    store.capture("one")
    const res = store.prune()
    expect(res.removed).toBeGreaterThanOrEqual(1)
    expect(res.bytes).toBeGreaterThan(0)
    expect(store.list()).toEqual([])
    expect(store.canUndo()).toBe(false)
  })

  it("repeat captures reuse hashes via the stat cache (no re-read)", async () => {
    const store = new CheckpointStore(dir)
    const first = await store.captureAsync("turn 1")
    const second = await store.captureAsync("turn 2")
    // Same workspace → same checkpoint content…
    expect(second.stateHash).toBe(first.stateHash)
    expect(second.fileCount).toBe(first.fileCount)
    // …and the manifest records the stats that spared the re-read.
    const manifestPath = path.join(dir, ".nemo", "checkpoints", `cp-${second.id}`, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      stats?: Record<string, { s: number; m: number }>
    }
    expect(Object.keys(manifest.stats ?? {}).length).toBe(second.fileCount)
    expect(manifest.stats?.["a.txt"]?.s).toBe(fs.statSync(path.join(dir, "a.txt")).size)
  })

  it("a restarted store reuses hashes from the persisted manifest stats", async () => {
    const first = await new CheckpointStore(dir).captureAsync("turn 1")
    // Fresh process, warm disk cache: the stat cache hydrates from the last
    // manifest, so content is identical without re-hashing anything new.
    const reopened = new CheckpointStore(dir)
    const second = await reopened.captureAsync("turn 2")
    expect(second.stateHash).toBe(first.stateHash)
  })

  it("modified files are re-hashed, untouched files are not", async () => {
    type Manifest = { files: Record<string, string | null>; stats?: Record<string, { s: number; m: number }> }
    const readManifest = (id: string): Manifest =>
      JSON.parse(
        fs.readFileSync(path.join(dir, ".nemo", "checkpoints", `cp-${id}`, "manifest.json"), "utf8"),
      ) as Manifest
    const store = new CheckpointStore(dir)
    const first = await store.captureAsync("turn 1")
    fs.writeFileSync(path.join(dir, "a.txt"), "CHANGED CONTENT LONGER")
    const second = await store.captureAsync("turn 2")
    expect(second.stateHash).not.toBe(first.stateHash)
    const m1 = readManifest(first.id)
    const m2 = readManifest(second.id)
    // Changed file: new size recorded, hash differs.
    expect(m2.stats?.["a.txt"]?.s).toBe(fs.statSync(path.join(dir, "a.txt")).size)
    expect(m2.files["a.txt"]).not.toBe(m1.files["a.txt"])
    // Untouched file: stat entry carried over.
    expect(m2.stats?.["b.txt"]).toEqual(m1.stats?.["b.txt"])
    expect(m2.files["b.txt"]).toBe(m1.files["b.txt"])
  })

  it("manifests without stats (pre-cache) still capture and restore", async () => {
    const store = new CheckpointStore(dir)
    store.capture("turn 1")
    const manifestPath = path.join(dir, ".nemo", "checkpoints", "cp-0001", "manifest.json")
    const stripped = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    delete stripped.stats
    fs.writeFileSync(manifestPath, JSON.stringify(stripped))
    // Fresh store over a stat-less manifest: full re-hash, then restore works.
    const reopened = new CheckpointStore(dir)
    const meta = await reopened.captureAsync("turn 2")
    expect(meta.fileCount).toBeGreaterThan(0)
    fs.writeFileSync(path.join(dir, "a.txt"), "MODIFIED")
    expect(reopened.undo().ok).toBe(true)
    expect(read("a.txt")).toBe("original A")
  })
})

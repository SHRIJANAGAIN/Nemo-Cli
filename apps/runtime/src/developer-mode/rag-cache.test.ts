/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { DeveloperModeEngine, RagCacheManager } from "./index.js"

let tmp = ""

const ragDir = (): string => path.join(tmp, "skt", "12-control", "devmode", "rag")
const ragFile = (): string => path.join(ragDir(), "rag-cache.json")

const makeEngine = (): DeveloperModeEngine => new DeveloperModeEngine(tmp, { enabled: true })

const makeManager = (engine: DeveloperModeEngine): RagCacheManager => new RagCacheManager(engine, tmp)

const SENTENCES = Array.from({ length: 8 }, (_, i) => `Sentence number ${String(i + 1).padStart(2, "0")} ends here.`)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-rag-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("RagCacheManager construction", () => {
  it("creates the rag directory and reports the cache file path", () => {
    const manager = makeManager(makeEngine())
    expect(fs.existsSync(ragDir())).toBe(true)
    expect(manager.getStats()).toEqual({ entries: 0, cacheFile: ragFile() })
  })

  it("hydrates the engine from an existing cache file", () => {
    fs.mkdirSync(ragDir(), { recursive: true })
    fs.writeFileSync(
      ragFile(),
      JSON.stringify([{ key: "k1", text: "loaded text", embedding: [1, 0], timestamp: 1, metadata: {} }]),
      "utf8",
    )
    const engine = makeEngine()
    makeManager(engine)
    expect(engine.getFromRagCache("k1")?.text).toBe("loaded text")
  })

  it("ignores a corrupt cache file instead of throwing", () => {
    fs.mkdirSync(ragDir(), { recursive: true })
    fs.writeFileSync(ragFile(), "not json at all", "utf8")
    const manager = makeManager(makeEngine())
    expect(manager.getStats().entries).toBe(0)
    expect(manager.get("k1")).toBeUndefined()
  })
})

describe("RagCacheManager.embedText", () => {
  it("returns a unit-length 384-dim vector, deterministic per text", () => {
    const manager = makeManager(makeEngine())
    const a = manager.embedText("apple pie recipe")
    expect(a).toHaveLength(384)
    expect(Math.sqrt(a.reduce((sum, v) => sum + v * v, 0))).toBeCloseTo(1, 5)
    expect(manager.embedText("apple pie recipe")).toEqual(a)
    expect(manager.embedText("quantum physics")).not.toEqual(a)
    expect(a[0]).toBeGreaterThan(0)
  })

  it("returns a zero vector for blank input", () => {
    const manager = makeManager(makeEngine())
    const blank = manager.embedText("   ")
    expect(blank).toHaveLength(384)
    expect(blank.every((v) => v === 0)).toBe(true)
  })
})

describe("RagCacheManager store/query", () => {
  it("store/get round-trip and miss behavior", () => {
    const manager = makeManager(makeEngine())
    manager.store("k1", "hello world", manager.embedText("hello world"))
    expect(manager.get("k1")).toEqual({ key: "k1", text: "hello world", score: 1, metadata: {} })
    expect(manager.get("missing")).toBeUndefined()
    expect(manager.getStats().entries).toBe(1)
  })

  it("query ranks matching text first and honors topK", () => {
    const manager = makeManager(makeEngine())
    // embedText() maps the i-th word to dim i, so a one-word query only
    // activates dim 0. Store orthogonal unit vectors so ranking is exact
    // rather than dependent on word hashes.
    const unit = (dim: number): number[] => {
      const v = new Array<number>(384).fill(0)
      v[dim] = 1
      return v
    }
    manager.store("apple", "apple pie recipe", unit(0))
    manager.store("physics", "quantum physics lecture", unit(1))

    const ranked = manager.query("apple")
    expect(ranked).toHaveLength(2)
    expect(ranked[0].key).toBe("apple")
    expect(ranked[0].score).toBeCloseTo(1)
    expect(ranked[1].key).toBe("physics")
    expect(ranked[1].score).toBe(0) // orthogonal to the query vector

    expect(manager.query("apple", 1)).toHaveLength(1)
    expect(manager.query("apple", 1)[0].key).toBe("apple")
  })

  it("the cache file is written after a store and survives a restart", () => {
    const engine1 = makeEngine()
    const manager1 = makeManager(engine1)
    manager1.store("k1", "persisted text", manager1.embedText("persisted text"))
    expect(fs.existsSync(ragFile())).toBe(true)
    const raw = JSON.parse(fs.readFileSync(ragFile(), "utf8")) as Array<{ key: string }>
    expect(raw.map((e) => e.key)).toContain("k1")

    const engine2 = makeEngine()
    const manager2 = makeManager(engine2)
    expect(manager2.get("k1")?.text).toBe("persisted text")
    expect(manager2.getStats().entries).toBe(1)
  })
})

describe("RagCacheManager.chunkText", () => {
  it("keeps a short text as a single chunk", () => {
    const manager = makeManager(makeEngine())
    const chunks = manager.chunkText("One sentence. Two sentence.")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("One sentence.")
    expect(chunks[0]).toContain("Two sentence.")
  })

  it("splits long text into overlapping chunks that cover every sentence", () => {
    const manager = makeManager(makeEngine())
    const text = SENTENCES.join(" ")
    const chunks = manager.chunkText(text, 100, 15)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true)
    const joined = chunks.join(" ")
    for (const sentence of SENTENCES) {
      expect(joined).toContain(sentence)
    }
  })

  it("does not split an atom that has no sentence boundary", () => {
    const manager = makeManager(makeEngine())
    const atom = "x".repeat(600)
    expect(manager.chunkText(atom, 100, 15)).toEqual([atom])
  })

  it("ingestDocument stores every chunk under keyed entries", () => {
    const manager = makeManager(makeEngine())
    manager.ingestDocument("doc", SENTENCES.join(" ").repeat(4)) // >512 chars → multiple chunks
    const stats = manager.getStats()
    expect(stats.entries).toBeGreaterThan(1)
    expect(manager.get("doc::chunk_0")?.text).toContain("Sentence number 01")
    expect(manager.get(`doc::chunk_${stats.entries - 1}`)).toBeDefined()
    expect(manager.get("doc::chunk_999")).toBeUndefined()
  })
})

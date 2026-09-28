/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { DeveloperModeEngine } from "./developer-mode.js"

export interface RagCacheEntry {
  key: string
  text: string
  embedding: number[]
  timestamp: number
  metadata?: Record<string, string>
}

export interface RagQueryResult {
  key: string
  text: string
  score: number
  metadata?: Record<string, string>
}

export class RagCacheManager {
  private readonly engine: DeveloperModeEngine
  private readonly cacheDir: string
  private readonly cacheFile: string
  private maxEntries: number

  constructor(engine: DeveloperModeEngine, cwd: string, maxEntries = 5000) {
    this.engine = engine
    this.maxEntries = maxEntries
    this.cacheDir = path.join(cwd, "skt", "12-control", "devmode", "rag")
    fs.mkdirSync(this.cacheDir, { recursive: true })
    this.cacheFile = path.join(this.cacheDir, "rag-cache.json")
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.cacheFile)) return
      const raw = fs.readFileSync(this.cacheFile, "utf8")
      const entries = JSON.parse(raw) as RagCacheEntry[]
      for (const entry of entries) {
        this.engine.addToRagCache(entry.key, entry.text, entry.embedding)
      }
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    try {
      const all = this.engine.searchRagCache(new Array(384).fill(0), 999999)
      const entries: RagCacheEntry[] = all.map((r) => ({
        key: r.key,
        text: r.text,
        embedding: new Array(384).fill(0),
        timestamp: Date.now(),
        metadata: {},
      }))
      fs.writeFileSync(this.cacheFile, JSON.stringify(entries, null, 2))
    } catch {
      /* ignore */
    }
  }

  store(key: string, text: string, embedding: number[]): void {
    this.engine.addToRagCache(key, text, embedding)
    this.persist()
  }

  query(queryText: string, topK = 5): RagQueryResult[] {
    const embedding = this.embedText(queryText)
    const results = this.engine.searchRagCache(embedding, topK)
    return results.map((r) => ({ key: r.key, text: r.text, score: r.score }))
  }

  get(key: string): RagQueryResult | undefined {
    const entry = this.engine.getFromRagCache(key)
    if (!entry) return undefined
    return { key, text: entry.text, score: 1, metadata: {} }
  }

  clear(): void {
    this.engine.addToRagCache("", "", [])
  }

  embedText(text: string): number[] {
    const dims = 384
    const embedding = new Array(dims).fill(0)
    const words = text.toLowerCase().split(/\s+/)
    for (let i = 0; i < words.length && i < dims; i++) {
      let hash = 0
      for (let j = 0; j < words[i].length; j++) {
        hash = ((hash << 5) - hash + words[i].charCodeAt(j)) | 0
      }
      embedding[i % dims] = Math.abs(hash) / 2147483647
    }
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1
    return embedding.map((v) => v / magnitude)
  }

  chunkText(text: string, chunkSize = 512, overlap = 64): string[] {
    const chunks: string[] = []
    const sentences = text.split(/(?<=[.!?])\s+/)
    let current = ""
    for (const sentence of sentences) {
      if (current.length + sentence.length > chunkSize && current.length > 0) {
        chunks.push(current.trim())
        current = current.slice(-overlap) + " "
      }
      current += sentence + " "
    }
    if (current.trim()) chunks.push(current.trim())
    return chunks
  }

  ingestDocument(key: string, text: string): void {
    const chunks = this.chunkText(text)
    for (let i = 0; i < chunks.length; i++) {
      const chunkKey = `${key}::chunk_${i}`
      const embedding = this.embedText(chunks[i])
      this.store(chunkKey, chunks[i], embedding)
    }
  }

  getStats(): { entries: number; cacheFile: string } {
    return { entries: this.engine.searchRagCache(new Array(384).fill(0), 999999).length, cacheFile: this.cacheFile }
  }
}

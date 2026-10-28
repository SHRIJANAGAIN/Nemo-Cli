/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Repetition Detector — 4-level repetition detection for AI output.
 * Level 1: Token repetition | Level 2: N-gram repetition
 * Level 3: Sentence repetition | Level 4: Semantic repetition
 */

export interface RepetitionResult {
  level: 0 | 1 | 2 | 3 | 4
  type: "none" | "token" | "ngram" | "sentence" | "semantic"
  detail: string
  position: number
  severity: "low" | "medium" | "high" | "critical"
}

export interface RepetitionConfig {
  tokenRepeatThreshold: number
  ngramSizes: number[]
  ngramRepeatThreshold: number
  sentenceRepeatThreshold: number
  semanticSimilarityThreshold: number
  semanticWindowSize: number
}

const DEFAULT_CONFIG: RepetitionConfig = {
  tokenRepeatThreshold: 5,
  ngramSizes: [2, 3, 4, 5],
  ngramRepeatThreshold: 3,
  sentenceRepeatThreshold: 2,
  semanticSimilarityThreshold: 0.85,
  semanticWindowSize: 5,
}

export class RepetitionDetector {
  private config: RepetitionConfig
  private buffer = ""
  private sentences: string[] = []
  private recentNgrams: Map<number, Map<string, number>> = new Map()

  constructor(config: Partial<RepetitionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    for (const n of this.config.ngramSizes) {
      this.recentNgrams.set(n, new Map())
    }
  }

  reset(): void {
    this.buffer = ""
    this.sentences = []
    for (const n of this.config.ngramSizes) {
      this.recentNgrams.set(n, new Map())
    }
  }

  ingest(delta: string): RepetitionResult {
    this.buffer += delta
    const r1 = this.checkTokenRepetition(delta)
    if (r1.level > 0) return r1
    const r2 = this.checkNgramRepetition()
    if (r2.level > 0) return r2
    const r3 = this.checkSentenceRepetition()
    if (r3.level > 0) return r3
    const r4 = this.checkSemanticRepetition()
    if (r4.level > 0) return r4
    return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
  }

  private checkTokenRepetition(delta: string): RepetitionResult {
    const tokens = delta.split(/\s+/).filter((t) => t.length > 0)
    if (tokens.length === 0) return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
    let maxRun = 1
    let currentRun = 1
    let maxToken = tokens[0]
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === tokens[i - 1]) {
        currentRun++
        if (currentRun > maxRun) {
          maxRun = currentRun
          maxToken = tokens[i]
        }
      } else {
        currentRun = 1
      }
    }
    if (maxRun >= this.config.tokenRepeatThreshold) {
      return {
        level: 1,
        type: "token",
        detail: `Token "${maxToken}" repeated ${maxRun} times consecutively`,
        position: this.buffer.length,
        severity: maxRun >= this.config.tokenRepeatThreshold + 3 ? "critical" : "high",
      }
    }
    return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
  }

  private checkNgramRepetition(): RepetitionResult {
    const tokens = this.buffer.split(/\s+/).filter((t) => t.length > 0)
    if (tokens.length < 2) return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
    for (const n of this.config.ngramSizes) {
      if (tokens.length < n) continue
      const ngramMap = this.recentNgrams.get(n)!
      const start = Math.max(0, tokens.length - 50)
      for (let i = start; i <= tokens.length - n; i++) {
        const ngram = tokens.slice(i, i + n).join(" ")
        const count = (ngramMap.get(ngram) || 0) + 1
        ngramMap.set(ngram, count)
        if (count >= this.config.ngramRepeatThreshold) {
          return {
            level: 2,
            type: "ngram",
            detail: `${n}-gram "${ngram.slice(0, 60)}..." repeated ${count} times`,
            position: this.buffer.length,
            severity: count >= this.config.ngramRepeatThreshold + 2 ? "critical" : "high",
          }
        }
      }
    }
    return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
  }

  private checkSentenceRepetition(): RepetitionResult {
    const newSentences = this.buffer
      .split(/[.!?]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 10)
    if (newSentences.length === 0) return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
    const counts = new Map<string, number>()
    for (const s of newSentences) {
      const normalized = s.replace(/\s+/g, " ").trim()
      counts.set(normalized, (counts.get(normalized) || 0) + 1)
    }
    for (const [sentence, count] of counts) {
      if (count >= this.config.sentenceRepeatThreshold) {
        return {
          level: 3,
          type: "sentence",
          detail: `Sentence "${sentence.slice(0, 60)}..." repeated ${count} times`,
          position: this.buffer.length,
          severity: count >= this.config.sentenceRepeatThreshold + 2 ? "critical" : "high",
        }
      }
    }
    return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
  }

  private checkSemanticRepetition(): RepetitionResult {
    const sentences = this.buffer
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15)
    if (sentences.length < 2) return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
    const window = this.config.semanticWindowSize
    const recent = sentences.slice(-window)
    for (let i = 0; i < recent.length; i++) {
      for (let j = i + 1; j < recent.length; j++) {
        const sim = this.computeSimilarity(recent[i], recent[j])
        if (sim >= this.config.semanticSimilarityThreshold) {
          return {
            level: 4,
            type: "semantic",
            detail: `Semantically similar (${Math.round(sim * 100)}%): "${recent[i].slice(0, 40)}..." vs "${recent[j].slice(0, 40)}..."`,
            position: this.buffer.length,
            severity: sim >= 0.95 ? "critical" : "high",
          }
        }
      }
    }
    return { level: 0, type: "none", detail: "", position: 0, severity: "low" }
  }

  private computeSimilarity(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    )
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    )
    if (wordsA.size === 0 || wordsB.size === 0) return 0
    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++
    }
    const union = new Set([...wordsA, ...wordsB]).size
    return union > 0 ? intersection / union : 0
  }

  getBufferLength(): number {
    return this.buffer.length
  }
}

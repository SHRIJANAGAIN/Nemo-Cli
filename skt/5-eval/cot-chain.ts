/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { WireMessage } from "../../packages/provider/src/types.js"
import {
  TaskAnalyzer,
  BudgetAllocator,
  type SotaOptions,
  type ScoredCandidate,
  type VerificationResult,
  type SotaEvent,
} from "../../apps/runtime/src/agent/sota.js"

export interface CotChainConfig {
  enabled: boolean
  maxDepth: number
  branchFactor: number
  verifier: "self" | "independent" | "both"
  uncertaintyThreshold: number
  infoGainBasedSearch: boolean
  debateRounds: number
  assumptionAttack: boolean
  reverseVerification: boolean
  externalizedScratchpad: boolean
}

export const DEFAULT_COT_CHAIN_CONFIG: CotChainConfig = {
  enabled: false,
  maxDepth: 5,
  branchFactor: 3,
  verifier: "self",
  uncertaintyThreshold: 0.4,
  infoGainBasedSearch: false,
  debateRounds: 0,
  assumptionAttack: false,
  reverseVerification: false,
  externalizedScratchpad: false,
}

export type CotEvent =
  | SotaEvent
  | {
      type: "debate_round"
      round: number
      candidate: ScoredCandidate
    }
  | {
      type: "assumption_attacked"
      critique: string
      isVulnerable: boolean
      weakestAssumption: string
    }
  | {
      type: "reverse_verify"
      passed: boolean
    }
  | {
      type: "scratchpad_update"
      candidateId: string
      content: string
    }

export function estimateCompute(
  config: CotChainConfig,
  difficulty: "easy" | "medium" | "hard" | "insane",
  confidence: number,
): { branches: number; depth: number; verification: number } {
  const base = {
    easy: { branches: 2, depth: 3, verification: 1 },
    medium: { branches: 3, depth: 6, verification: 2 },
    hard: { branches: 5, depth: 12, verification: 3 },
    insane: { branches: 8, depth: 20, verification: 5 },
  }

  const b = base[difficulty]
  const confidenceFactor = 1 + (1 - confidence) * 0.5

  return {
    branches: Math.max(1, Math.round(b.branches * config.branchFactor * confidenceFactor)),
    depth: Math.max(1, Math.round(((b.depth * config.maxDepth) / 5) * confidenceFactor)),
    verification: Math.max(1, Math.round(b.verification * confidenceFactor)),
  }
}

export class CotChainEngine {
  config: CotChainConfig
  private readonly options: SotaOptions
  private readonly analyzer: TaskAnalyzer
  private readonly budgetAllocator: BudgetAllocator
  private readonly events: CotEvent[] = []
  private aborted = false

  constructor(options: SotaOptions, config: Partial<CotChainConfig> = {}) {
    this.options = options
    this.config = { ...DEFAULT_COT_CHAIN_CONFIG, ...config }
    this.analyzer = new TaskAnalyzer()
    this.budgetAllocator = new BudgetAllocator()
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.options.signal = signal
  }

  setOnEvent(fn: (event: CotEvent) => void): void {
    this.options.onEvent = fn as (event: SotaEvent) => void
  }

  private emit(event: CotEvent): void {
    this.events.push(event)
    this.options.onEvent?.(event as SotaEvent)
  }

  async solve(problem: string): Promise<ScoredCandidate | null> {
    if (this.options.signal?.aborted) return null
    if (!this.config.enabled) {
      const single = await this.options.generate(
        this.buildSystemPrompt(problem, { difficulty: "medium", category: "general", confidence: 0.5 }),
        [{ role: "user", content: problem }],
        { temperature: 0.2, maxTokens: 2048 },
      )
      return {
        id: `cand-${Date.now()}`,
        text: single,
        score: 0.5,
        verification: {
          correctness: "UNCERTAIN",
          evidence: [],
          consistency: 0.5,
          progress: 0.5,
          confidence: 0.5,
        },
        dead: false,
        needsRecheck: false,
        depth: 0,
      }
    }

    const analysis = this.analyzer.analyze(problem)
    const budget = estimateCompute(this.config, analysis.difficulty, analysis.confidence)

    this.emit({
      type: "difficulty_estimated",
      difficulty: analysis.difficulty,
      budget,
    } as CotEvent)

    let candidates: ScoredCandidate[] = []

    if (this.config.debateRounds > 0 && this.config.verifier !== "self") {
      candidates = await this.runDebate(problem, analysis, budget)
    } else {
      candidates = await this.generateWithBranching(problem, analysis, budget)
    }

    for (const candidate of candidates) {
      candidate.verification = await this.verifyCandidate(problem, candidate.text, this.config.verifier)
      candidate.score = this.computeScore(candidate.verification)
      this.emit({ type: "candidate_scored", candidate, rank: 0 } as CotEvent)
    }

    candidates.sort((a, b) => b.score - a.score)

    if (this.config.reverseVerification) {
      const best = candidates[0]
      if (best) {
        const reversed = await this.reverseVerify(problem, best.text)
        this.emit({ type: "reverse_verify", passed: reversed } as CotEvent)
        if (!reversed && candidates.length > 1) {
          return candidates[1]
        }
      }
    }

    if (this.config.assumptionAttack) {
      const best = candidates[0]
      if (best) {
        const attack = await this.attackAssumptions(problem, best.text)
        this.emit({ type: "assumption_attacked", critique: attack.critique } as CotEvent)
        if (attack.isVulnerable) {
          for (let i = 1; i < candidates.length; i++) {
            if (candidates[i].verification.correctness === "PASS") {
              return candidates[i]
            }
          }
        }
      }
    }

    const best = candidates[0]
    if (best) {
      this.emit({ type: "solution_found", candidate: best } as CotEvent)
    }

    this.emit({
      type: "search_complete",
      best: best ?? null,
      candidates,
    } as CotEvent)

    return best ?? null
  }

  private async runDebate(
    problem: string,
    analysis: { difficulty: string; category: string; confidence: number },
    _budget: { branches: number; depth: number; verification: number },
  ): Promise<ScoredCandidate[]> {
    const systemPrompt = this.buildSystemPrompt(problem, analysis)
    const messages: WireMessage[] = [
      { role: "user", content: problem },
      {
        role: "assistant",
        content: `You are a critical reviewer. Analyze the problem and produce your solution independently. Do not coordinate with other reviewers.`,
      },
    ]

    const allCandidates: ScoredCandidate[] = []

    for (let round = 0; round < this.config.debateRounds; round++) {
      if (this.options.signal?.aborted) break

      const text = await this.options.generate(systemPrompt, messages, {
        temperature: 0.3 + round * 0.15,
        maxTokens: 2048,
      })

      const candidate: ScoredCandidate = {
        id: `debate-${round}-${Date.now()}`,
        text,
        score: 0,
        verification: {
          correctness: "UNCERTAIN",
          evidence: [],
          consistency: 0,
          progress: 0,
          confidence: 0,
        },
        dead: false,
        needsRecheck: false,
        depth: round,
        approach: `debate-round-${round}`,
      }

      allCandidates.push(candidate)
      this.emit({ type: "debate_round", round, candidate } as CotEvent)
    }

    return allCandidates
  }

  private async generateWithBranching(
    problem: string,
    analysis: { difficulty: string; category: string; confidence: number },
    _budget: { branches: number; depth: number; verification: number },
  ): Promise<ScoredCandidate[]> {
    const systemPrompt = this.buildSystemPrompt(problem, analysis)
    const messages: WireMessage[] = [{ role: "user", content: problem }]

    const candidates: ScoredCandidate[] = []

    const branchCount = Math.min(_budget.branches, this.config.branchFactor)

    for (let i = 0; i < branchCount; i++) {
      if (this.options.signal?.aborted) break

      const temp = this.config.externalizedScratchpad
        ? 0.4 + i * 0.1 + (analysis.confidence < 0.5 ? 0.1 : 0)
        : 0.3 + i * 0.15

      let prompt = systemPrompt
      if (this.config.externalizedScratchpad) {
        prompt +=
          "\n\nUse an externalized scratchpad format:\n\nGOAL:\n...\nKNOWN:\n...\nUNKNOWN:\n...\nASSUMPTIONS:\n...\nSUBGOALS:\n...\nEVIDENCE:\n...\nCURRENT STATE:\n..."
      }

      const text = await this.options.generate(prompt, messages, {
        temperature: temp,
        maxTokens: 2048,
      })

      const candidate: ScoredCandidate = {
        id: `cand-${i}-${Date.now()}`,
        text,
        score: 0,
        verification: {
          correctness: "UNCERTAIN",
          evidence: [],
          consistency: 0,
          progress: 0,
          confidence: 0,
        },
        dead: false,
        needsRecheck: false,
        depth: 0,
        approach: `branch-${i + 1}`,
      }

      if (this.config.externalizedScratchpad) {
        this.emit({ type: "scratchpad_update", candidateId: candidate.id, content: text.slice(0, 200) } as CotEvent)
      }

      candidates.push(candidate)
    }

    return this.pruneAndExpand(problem, analysis, candidates)
  }

  private async pruneAndExpand(
    problem: string,
    analysis: { difficulty: string; category: string; confidence: number },
    candidates: ScoredCandidate[],
  ): Promise<ScoredCandidate[]> {
    for (const candidate of candidates) {
      candidate.verification = await this.verifyCandidate(problem, candidate.text, this.config.verifier)
      candidate.score = this.computeScore(candidate.verification)
    }

    const alive = candidates.filter((c) => c.verification.correctness !== "FAIL")

    if (alive.length === 0) return candidates

    const sorted = alive.sort((a, b) => b.score - a.score)
    const topK = sorted.slice(0, this.config.branchFactor)

    if (this.config.infoGainBasedSearch) {
      const ranked = await this.rankByInfoGain(problem, topK)
      if (ranked.length > 1) {
        const best = ranked[0]
        const second = ranked[1]

        if (Math.abs(best.score - second.score) > this.config.uncertaintyThreshold) {
          return ranked
        }

        const dispute = await this.resolveDisagreement(problem, best.text, second.text)
        if (dispute.resolved && dispute.resolution) {
          return [dispute.resolution, ...ranked.slice(1)]
        }
      }
    }

    return topK.length > 0 ? topK : sorted
  }

  private async rankByInfoGain(problem: string, candidates: ScoredCandidate[]): Promise<ScoredCandidate[]> {
    const sorted = [...candidates].sort((a, b) => {
      const infoA = (1 - a.verification.confidence) * a.score
      const infoB = (1 - b.verification.confidence) * b.score
      return infoB - infoA
    })

    for (let i = 0; i < Math.min(sorted.length, 3); i++) {
      if (sorted[i].verification.correctness === "UNCERTAIN") {
        const reSolved = await this.reSolveCandidate(problem, sorted[i])
        sorted[i].text = reSolved.text
        sorted[i].verification = reSolved.verification
        sorted[i].score = this.computeScore(sorted[i].verification)
      }
    }

    return sorted.sort((a, b) => b.score - a.score)
  }

  private async resolveDisagreement(
    problem: string,
    solutionA: string,
    solutionB: string,
  ): Promise<{ resolved: boolean; resolution: ScoredCandidate | null }> {
    if (!this.options.verify) {
      return { resolved: false, resolution: null }
    }

    const critiqueA = await this.options.generate(
      `You are a critical reviewer. Find the strongest possible counterexample that would make this solution wrong.\n\nProblem: ${problem}\n\nSolution A:\n${solutionA}\n\nFind a counterexample:`,
      [{ role: "user", content: `Find the strongest counterexample to Solution A for the given problem.` }],
      { temperature: 0.5, maxTokens: 1024 },
    )

    const critiqueB = await this.options.generate(
      `You are a critical reviewer. Find the strongest possible counterexample that would make this solution wrong.\n\nProblem: ${problem}\n\nSolution B:\n${solutionB}\n\nFind a counterexample:`,
      [{ role: "user", content: `Find the strongest counterexample to Solution B for the given problem.` }],
      { temperature: 0.5, maxTokens: 1024 },
    )

    const verifyA = await this.options.verify(problem, solutionA)
    const verifyB = await this.options.verify(problem, solutionB)

    let resolution: ScoredCandidate | null = null

    if (verifyA.correctness === "PASS" && verifyB.correctness === "FAIL") {
      resolution = {
        id: `dispute-resolved-${Date.now()}`,
        text: solutionA,
        score: this.computeScore(verifyA),
        verification: verifyA,
        dead: false,
        needsRecheck: false,
        depth: 0,
      }
    } else if (verifyB.correctness === "PASS" && verifyA.correctness === "FAIL") {
      resolution = {
        id: `dispute-resolved-${Date.now()}`,
        text: solutionB,
        score: this.computeScore(verifyB),
        verification: verifyB,
        dead: false,
        needsRecheck: false,
        depth: 0,
      }
    }

    void critiqueA
    void critiqueB

    return { resolved: resolution !== null, resolution }
  }

  private async verifyCandidate(
    problem: string,
    solution: string,
    mode: "self" | "independent" | "both",
  ): Promise<VerificationResult> {
    if (!this.options.verify) {
      return {
        correctness: "UNCERTAIN",
        evidence: ["no verifier available"],
        consistency: 0.5,
        progress: 0.5,
        confidence: 0.5,
      }
    }

    const selfCheck = await this.options.verify(problem, solution)

    if (mode === "self") {
      return selfCheck
    }

    const independentPrompt = `Solve this problem independently without seeing any previous solution.\n\nProblem:\n${problem}\n\nProvide your own solution.`
    const independentSolution = await this.options.generate(independentPrompt, [{ role: "user", content: problem }], {
      temperature: 0.2,
      maxTokens: 2048,
    })

    const independentCheck = await this.options.verify(problem, independentSolution)

    if (selfCheck.correctness === "PASS" && independentCheck.correctness === "FAIL") {
      return {
        correctness: "UNCERTAIN",
        evidence: ["self pass", "independent fail - disagreement"],
        consistency: 0.3,
        progress: 0.5,
        confidence: 0.3,
        critique: "Self-verification passed but independent solution failed — disagreement detected.",
      }
    }

    if (selfCheck.correctness === "FAIL" && independentCheck.correctness === "PASS") {
      return {
        correctness: "PASS",
        evidence: ["independent pass resolves self fail"],
        consistency: 0.8,
        progress: 0.9,
        confidence: 0.7,
      }
    }

    return {
      correctness: selfCheck.correctness,
      evidence: [...selfCheck.evidence, ...independentCheck.evidence],
      consistency: (selfCheck.consistency + independentCheck.consistency) / 2,
      progress: Math.max(selfCheck.progress, independentCheck.progress),
      confidence: (selfCheck.confidence + independentCheck.confidence) / 2,
    }
  }

  private async reverseVerify(problem: string, solution: string): Promise<boolean> {
    if (!this.options.generate) return true

    const prompt = `Given the following problem and proposed solution, work backwards:
Does the proposed solution actually imply the answer to the original problem?
Identify any step where the solution fails to address the original question.

Problem: ${problem}

Solution:
${solution}

Analysis:`
    const analysis = await this.options.generate(prompt, [{ role: "user", content: prompt }], {
      temperature: 0.1,
      maxTokens: 1024,
    })

    return !analysis.toLowerCase().includes("fails to address") && !analysis.toLowerCase().includes("does not actually")
  }

  private async attackAssumptions(
    problem: string,
    solution: string,
  ): Promise<{
    isVulnerable: boolean
    critique: string
    weakestAssumption: string
  }> {
    const prompt = `You are a critical reviewer. Your job is to destroy this solution.

Problem: ${problem}

Solution:
${solution}

Find the single weakest assumption in the solution. If that assumption were wrong, would the entire solution collapse?
Respond in this format:
WEAKEST ASSUMPTION: <the assumption>
IMPACT: <how it would break the solution>
VULNERABLE: <yes or no>`

    const critique = await this.options.generate(prompt, [{ role: "user", content: prompt }], {
      temperature: 0.5,
      maxTokens: 1024,
    })

    const isVulnerable = critique.toLowerCase().includes("vulnerable: yes")
    const weakestMatch = critique.match(/WEAKEST ASSUMPTION:\s*(.+)/i)
    const weakestAssumption = weakestMatch ? weakestMatch[1].trim() : "unknown"

    return {
      isVulnerable,
      critique,
      weakestAssumption,
    }
  }

  private async reSolveCandidate(problem: string, candidate: ScoredCandidate): Promise<ScoredCandidate> {
    const systemPrompt = this.buildSystemPrompt(problem, {
      difficulty: "hard",
      category: "general",
      confidence: 0.3,
    })

    const messages: WireMessage[] = [
      { role: "user", content: problem },
      { role: "assistant", content: candidate.text },
      {
        role: "user",
        content:
          "Your previous solution had uncertainty. Re-examine, find the weakest point, and provide a corrected, more confident answer.",
      },
    ]

    const newText = await this.options.generate(systemPrompt, messages, {
      temperature: 0.2,
      maxTokens: 2048,
    })

    const verification = await this.verifyCandidate(problem, newText, this.config.verifier)

    return {
      id: candidate.id,
      text: newText,
      score: this.computeScore(verification),
      verification,
      dead: verification.correctness === "FAIL",
      needsRecheck: verification.correctness === "UNCERTAIN",
      depth: candidate.depth + 1,
    }
  }

  private computeScore(verification: VerificationResult): number {
    const correctnessWeight = 0.5
    const consistencyWeight = 0.2
    const progressWeight = 0.15
    const confidenceWeight = 0.15

    let score = 0

    if (verification.correctness === "PASS") {
      score += correctnessWeight
    } else if (verification.correctness === "UNCERTAIN") {
      score += correctnessWeight * 0.5
    }

    score += verification.consistency * consistencyWeight
    score += verification.progress * progressWeight
    score += verification.confidence * confidenceWeight

    return Math.max(0, Math.min(1, score))
  }

  private buildSystemPrompt(
    problem: string,
    analysis: { difficulty: string; category: string; confidence: number },
  ): string {
    let prompt = `You are an expert reasoning assistant solving a ${analysis.difficulty}-difficulty ${analysis.category} problem.

Problem: ${problem}

Reasoning configuration:
- Verifier mode: ${this.config.verifier}
- Uncertainty threshold: ${this.config.uncertaintyThreshold}
- Info-gain search: ${this.config.infoGainBasedSearch ? "ON" : "OFF"}
- Debate rounds: ${this.config.debateRounds}
- Assumption attack: ${this.config.assumptionAttack ? "ON" : "OFF"}
- Reverse verification: ${this.config.reverseVerification ? "ON" : "OFF"}
- Externalized scratchpad: ${this.config.externalizedScratchpad ? "ON" : "OFF"}`

    if (this.config.externalizedScratchpad) {
      prompt += `\n\nUse a structured externalized scratchpad with sections: GOAL, KNOWN, UNKNOWN, ASSUMPTIONS, SUBGOALS, EVIDENCE, CURRENT STATE.`
    }

    if (this.config.assumptionAttack) {
      prompt += `\n\nAfter solving, be ready to list your assumptions explicitly for a critic to attack.`
    }

    prompt += `\n\nProvide a clear, step-by-step solution. Be explicit about your reasoning.`

    return prompt
  }

  abort(): void {
    this.aborted = true
  }
}

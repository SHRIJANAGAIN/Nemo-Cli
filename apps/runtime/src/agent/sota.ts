/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { WireMessage } from "../../../../packages/provider/src/types.js"

export type Difficulty = "easy" | "medium" | "hard" | "insane"

export interface Budget {
  branches: number
  depth: number
  verification: number
}

export interface VerificationResult {
  correctness: "PASS" | "FAIL" | "UNCERTAIN"
  evidence: string[]
  consistency: number
  progress: number
  confidence: number
  critique?: string
}

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface ScoredCandidate {
  id: string
  text: string
  score: number
  verification: VerificationResult
  execution?: ExecutionResult
  dead: boolean
  needsRecheck: boolean
  depth: number
  parentId?: string
  approach?: string
}

export interface SotaOptions {
  generate: (
    system: string,
    messages: WireMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ) => Promise<string>
  verify?: (problem: string, solution: string) => Promise<VerificationResult>
  execute?: (code: string) => Promise<ExecutionResult>
  testCode?: (code: string, tests: string) => Promise<{ passed: boolean; output: string }>
  onEvent?: (event: SotaEvent) => void
  signal?: AbortSignal
  maxCandidates?: number
}

export type SotaEvent =
  | { type: "difficulty_estimated"; difficulty: Difficulty; budget: Budget }
  | { type: "candidate_generated"; candidate: ScoredCandidate }
  | { type: "candidate_scored"; candidate: ScoredCandidate; rank: number }
  | { type: "branch_pruned"; candidateId: string; reason: string }
  | { type: "backtracking"; fromCandidateId: string; reason: string }
  | { type: "re_solve"; candidateId: string; reason: string }
  | { type: "solution_found"; candidate: ScoredCandidate }
  | { type: "search_complete"; best: ScoredCandidate; candidates: ScoredCandidate[] }
  | { type: "compute_used"; used: number; max: number }

let candidateCounter = 0

export class TaskAnalyzer {
  analyze(problem: string): { difficulty: Difficulty; category: string; confidence: number } {
    const len = problem.length
    const lower = problem.toLowerCase()

    let difficulty: Difficulty
    if (len < 50) {
      difficulty = "easy"
    } else if (len < 200 && this.hasSingleDomain(lower)) {
      difficulty = "medium"
    } else if (len < 500 && this.hasMultiDomain(lower)) {
      difficulty = "hard"
    } else {
      difficulty = "insane"
    }

    const category = this.detectCategory(lower)
    const confidence = this.estimateConfidence(len, difficulty)

    return { difficulty, category, confidence }
  }

  private hasSingleDomain(text: string): boolean {
    const domains = ["code", "function", "api", "class", "method", "variable", "database", "sql", "test", "bug"]
    return domains.some((d) => text.includes(d))
  }

  private hasMultiDomain(text: string): boolean {
    const domains = ["frontend", "backend", "database", "api", "auth", "cache", "queue", "deploy"]
    return domains.filter((d) => text.includes(d)).length >= 2
  }

  private detectCategory(text: string): string {
    if (/\b(code|function|class|api|debug|refactor|implement)\b/.test(text)) return "coding"
    if (/\b(math|calculate|equation|formula|number|compute)\b/.test(text)) return "math"
    if (/\b(write|essay|article|story|explain|describe)\b/.test(text)) return "writing"
    if (/\b(analyze|compare|evaluate|assess|research)\b/.test(text)) return "analysis"
    return "general"
  }

  private estimateConfidence(len: number, difficulty: Difficulty): number {
    const base = difficulty === "easy" ? 0.9 : difficulty === "medium" ? 0.7 : difficulty === "hard" ? 0.5 : 0.3
    const lenFactor = Math.min(1, len / 500)
    return base * (1 - lenFactor * 0.2)
  }
}

export class BudgetAllocator {
  allocate(difficulty: Difficulty, confidence: number): Budget {
    const baseBranches = difficulty === "easy" ? 2 : difficulty === "medium" ? 3 : difficulty === "hard" ? 5 : 8
    const baseDepth = difficulty === "easy" ? 2 : difficulty === "medium" ? 3 : difficulty === "hard" ? 5 : 8
    const baseVerification = difficulty === "easy" ? 1 : difficulty === "medium" ? 2 : difficulty === "hard" ? 3 : 5

    const confidenceFactor = 1 + (1 - confidence) * 0.5

    return {
      branches: Math.max(1, Math.round(baseBranches * confidenceFactor)),
      depth: Math.max(1, Math.round(baseDepth * confidenceFactor)),
      verification: Math.max(1, Math.round(baseVerification * confidenceFactor)),
    }
  }
}

export class SearchNode {
  readonly id: string
  readonly problem: string
  readonly parentId: string | null
  readonly depth: number
  candidates: ScoredCandidate[]
  children: string[]
  visits: number
  totalScore: number

  constructor(id: string, problem: string, parentId: string | null, depth: number) {
    this.id = id
    this.problem = problem
    this.parentId = parentId
    this.depth = depth
    this.candidates = []
    this.children = []
    this.visits = 0
    this.totalScore = 0
  }

  bestCandidate(): ScoredCandidate | null {
    if (this.candidates.length === 0) return null
    // Prefer an ALIVE candidate: the search loop expands the best candidate,
    // and a dead pick can never progress. Only fall back to dead candidates
    // when nothing is alive (e.g. the end-of-search "best so far" report).
    const alive = this.candidates.filter((c) => !c.dead)
    const pool = alive.length > 0 ? alive : this.candidates
    return [...pool].sort((a, b) => b.score - a.score)[0]
  }

  aliveCandidates(): ScoredCandidate[] {
    return this.candidates.filter((c) => !c.dead)
  }

  addChild(childId: string): void {
    this.children.push(childId)
  }

  recordVisit(score: number): void {
    this.visits += 1
    this.totalScore += score
  }

  averageScore(): number {
    return this.visits > 0 ? this.totalScore / this.visits : 0
  }
}

export class SotaReasoningEngine {
  private readonly options: SotaOptions
  private readonly analyzer: TaskAnalyzer
  private readonly budgetAllocator: BudgetAllocator
  private readonly nodes: Map<string, SearchNode>
  private readonly rootId: string
  private aborted = false

  constructor(options: SotaOptions) {
    this.options = options
    this.analyzer = new TaskAnalyzer()
    this.budgetAllocator = new BudgetAllocator()
    this.nodes = new Map()
    this.rootId = this.createNodeId()
  }

  setOnEvent(fn: SotaOptions["onEvent"]): void {
    this.options.onEvent = fn
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.options.signal = signal
  }

  private createNodeId(): string {
    candidateCounter += 1
    return `node-${candidateCounter}`
  }

  private createCandidateId(): string {
    candidateCounter += 1
    return `cand-${candidateCounter}`
  }

  async solve(problem: string): Promise<ScoredCandidate | null> {
    if (this.options.signal?.aborted) return null

    const analysis = this.analyzer.analyze(problem)
    const budget = this.budgetAllocator.allocate(analysis.difficulty, analysis.confidence)
    this.emit({ type: "difficulty_estimated", difficulty: analysis.difficulty, budget })

    const root = new SearchNode(this.rootId, problem, null, 0)
    this.nodes.set(this.rootId, root)

    const systemPrompt = this.buildSystemPrompt(problem, analysis)
    const messages: WireMessage[] = [{ role: "user", content: problem }]

    const candidates = await this.generateCandidates(root, messages, systemPrompt, budget.branches)
    for (const candidate of candidates) {
      root.candidates.push(candidate)
      const scored = await this.processCandidate(root, candidate)
      root.recordVisit(scored.score)
      let rank = 1
      for (const other of root.candidates) {
        if (other.score !== undefined && other.score > scored.score) rank++
      }
      this.emit({ type: "candidate_scored", candidate: scored, rank })
    }

    if (root.aliveCandidates().length === 0) {
      const best = root.bestCandidate()
      this.emit({ type: "search_complete", best: best ?? root.candidates[0], candidates: root.candidates })
      return best ?? null
    }

    let currentDepth = 1
    let converged = false

    while (currentDepth < budget.depth && !converged && !this.aborted) {
      if (this.options.signal?.aborted) break

      const alive = root.aliveCandidates()
      if (alive.length === 0) break

      const bestNode = this.selectBest([root])
      if (!bestNode) break

      const parentCandidate = bestNode.bestCandidate()
      // bestCandidate() prefers an alive candidate, so a dead pick here means
      // NOTHING on this node is expandable — break instead of `continue`,
      // which re-picked the same dead candidate forever (no await, no depth
      // increment — a hard synchronous spin that even the abort signal
      // couldn't interrupt).
      if (!parentCandidate) break
      if (parentCandidate.dead) break

      for (const candidate of bestNode.aliveCandidates()) {
        if (candidate.needsRecheck) {
          await this.reSolve(bestNode, candidate)
          this.emit({ type: "re_solve", candidateId: candidate.id, reason: "uncertainty_recheck" })
        }
      }

      const childId = this.createNodeId()
      const childNode = new SearchNode(childId, problem, bestNode.id, currentDepth)
      bestNode.addChild(childId)
      this.nodes.set(childId, childNode)

      const childMessages: WireMessage[] = [
        { role: "user", content: problem },
        { role: "assistant", content: parentCandidate.text } as WireMessage,
        {
          role: "user",
          content: "Continue and refine the previous approach. Address any gaps or failures identified.",
        } as WireMessage,
      ]

      const newCandidates = await this.generateCandidates(
        childNode,
        childMessages,
        systemPrompt,
        Math.max(1, budget.branches - 1),
      )
      for (const candidate of newCandidates) {
        childNode.candidates.push(candidate)
        const scored = await this.processCandidate(childNode, candidate)
        childNode.recordVisit(scored.score)
        this.emit({ type: "candidate_generated", candidate: scored })
      }

      this.pruneFrontier()
      converged = this.checkConvergence()
      currentDepth += 1

      this.emit({ type: "compute_used", used: currentDepth, max: budget.depth })
    }

    const allNodes = [...this.nodes.values()]
    const bestNode =
      allNodes.length > 0
        ? allNodes.reduce(
            (best, node) => {
              const nodeScore = node.visits > 0 ? node.totalScore / node.visits : 0
              const bestScore = best && best.visits > 0 ? best.totalScore / best.visits : 0
              return nodeScore > bestScore ? node : best
            },
            null as SearchNode | null,
          )
        : null
    const finalBest = bestNode?.bestCandidate() ?? root.bestCandidate()

    if (finalBest) {
      const verified = await this.finalVerification(problem, finalBest)
      finalBest.verification = verified
      finalBest.score = this.computeScore(verified, finalBest.execution)
      this.emit({ type: "solution_found", candidate: finalBest })
    }

    const allCandidates: ScoredCandidate[] = []
    for (const node of this.nodes.values()) {
      allCandidates.push(...node.candidates)
    }
    this.emit({ type: "search_complete", best: finalBest ?? allCandidates[0], candidates: allCandidates })
    return finalBest ?? null
  }

  async generateCandidates(
    node: SearchNode,
    messages: WireMessage[],
    systemPrompt: string,
    count: number,
  ): Promise<ScoredCandidate[]> {
    const results: ScoredCandidate[] = []
    for (let i = 0; i < count; i++) {
      if (this.options.signal?.aborted) break

      const text = await this.options.generate(systemPrompt, messages, {
        temperature: 0.3 + i * 0.15,
        maxTokens: 2048,
      })

      const id = this.createCandidateId()
      const candidate: ScoredCandidate = {
        id,
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
        depth: node.depth,
        parentId: node.parentId ?? undefined,
        approach: `branch-${i + 1}`,
      }
      results.push(candidate)
    }
    return results
  }

  async processCandidate(node: SearchNode, candidate: ScoredCandidate): Promise<ScoredCandidate> {
    const verifyFn = this.options.verify
    if (verifyFn) {
      try {
        candidate.verification = await verifyFn(node.problem, candidate.text)
      } catch {
        candidate.verification = {
          correctness: "FAIL",
          evidence: ["verification_error"],
          consistency: 0,
          progress: 0,
          confidence: 0,
          critique: "Verification step failed.",
        }
      }
    }

    candidate.dead = candidate.verification.correctness === "FAIL"
    candidate.needsRecheck = candidate.verification.correctness === "UNCERTAIN"
    candidate.score = this.computeScore(candidate.verification, candidate.execution)

    if (candidate.dead) {
      this.emit({ type: "branch_pruned", candidateId: candidate.id, reason: "verification_failed" })
    }

    return candidate
  }

  async reSolve(parentNode: SearchNode, candidate: ScoredCandidate): Promise<ScoredCandidate> {
    const analysis = this.analyzer.analyze(parentNode.problem)
    const systemPrompt = this.buildSystemPrompt(parentNode.problem, {
      difficulty: analysis.difficulty,
      category: "general",
      confidence: 0.5,
    })
    const messages: WireMessage[] = [
      { role: "user", content: parentNode.problem },
      { role: "assistant", content: candidate.text } as WireMessage,
      {
        role: "user",
        content: "Your previous solution had uncertainty. Re-examine and provide a corrected, more confident answer.",
      } as WireMessage,
    ]

    try {
      const newText = await this.options.generate(systemPrompt, messages, { temperature: 0.2, maxTokens: 2048 })
      candidate.text = newText
      candidate.verification = this.options.verify
        ? await this.options.verify(parentNode.problem, newText)
        : candidate.verification
      candidate.dead = candidate.verification.correctness === "FAIL"
      candidate.needsRecheck = candidate.verification.correctness === "UNCERTAIN"
      candidate.score = this.computeScore(candidate.verification, candidate.execution)
    } catch {
      candidate.dead = true
      this.emit({ type: "backtracking", fromCandidateId: candidate.id, reason: "re_solve_failed" })
    }

    return candidate
  }

  async finalVerification(problem: string, candidate: ScoredCandidate): Promise<VerificationResult> {
    if (this.options.verify) {
      try {
        return await this.options.verify(problem, candidate.text)
      } catch {
        // fall through to return cached verification
      }
    }
    return candidate.verification
  }

  selectBest(nodes: SearchNode[]): SearchNode | null {
    if (nodes.length === 0) return null

    return [...nodes].sort((a, b) => {
      const uctA =
        a.visits > 0 ? a.totalScore / a.visits + Math.sqrt((2 * Math.log(a.visits + 1)) / (a.visits + 1)) : Infinity
      const uctB =
        b.visits > 0 ? b.totalScore / b.visits + Math.sqrt((2 * Math.log(b.visits + 1)) / (b.visits + 1)) : Infinity
      return uctB - uctA
    })[0]
  }

  pruneFrontier(): void {
    const maxCandidates = this.options.maxCandidates ?? 16
    const allCandidates: { candidate: ScoredCandidate; nodeId: string }[] = []

    for (const node of this.nodes.values()) {
      for (const candidate of node.candidates) {
        allCandidates.push({ candidate, nodeId: node.id })
      }
    }

    allCandidates.sort((a, b) => b.candidate.score - a.candidate.score)

    const kept = new Set(allCandidates.slice(0, maxCandidates).map((c) => c.candidate.id))

    for (const item of allCandidates) {
      if (!kept.has(item.candidate.id) && !item.candidate.dead) {
        item.candidate.dead = true
        this.emit({ type: "branch_pruned", candidateId: item.candidate.id, reason: "frontier_capacity" })
      }
    }
  }

  checkConvergence(): boolean {
    const alive: ScoredCandidate[] = []
    for (const node of this.nodes.values()) {
      alive.push(...node.aliveCandidates())
    }

    if (alive.length < 3) return false

    const scores = alive.map((c) => c.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)

    return max - min < 0.05
  }

  computeScore(verification: VerificationResult, execution?: ExecutionResult): number {
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

    if (execution) {
      if (execution.exitCode === 0) {
        score += 0.05
      }
      if (execution.timedOut) {
        score -= 0.1
      }
      if (execution.stderr.length > 0) {
        score -= 0.05
      }
    }

    return Math.max(0, Math.min(1, score))
  }

  private buildSystemPrompt(
    problem: string,
    analysis: { difficulty: Difficulty; category: string; confidence: number },
  ): string {
    return `You are an expert reasoning assistant solving a ${analysis.difficulty}-difficulty ${analysis.category} problem.
Problem: ${problem}
Provide a clear, step-by-step solution. Be explicit about your reasoning.`
  }

  private emit(event: SotaEvent): void {
    if (this.options.onEvent) {
      this.options.onEvent(event)
    }
  }

  abort(): void {
    this.aborted = true
  }
}

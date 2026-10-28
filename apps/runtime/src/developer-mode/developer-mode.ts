/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { Tool } from "../tools/index.js"
import type { Provider, ProviderOptions } from "../../../../packages/provider/src/types.js"
import {
  DEFAULT_LOCAL_SUPERVISOR_CONFIG,
  isSupervisorConfigured,
  requestSupervisorDecision,
  sanitizeSupervisorConfig,
  type LocalSupervisorConfig,
  type SupervisorDecision,
} from "./local-supervisor.js"

export type ControlMode = "general" | "accurate"

export type PenaltyLevel = 1 | 2 | 3 | 4 | 5

export type VerifierMode = "self" | "independent" | "both"

export interface CotChainSubMenu {
  enabled: boolean
  maxDepth: number
  branchFactor: number
  verifier: VerifierMode
  uncertaintyThreshold: number
  infoGainBasedSearch: boolean
  debateRounds: number
  assumptionAttack: boolean
  reverseVerification: boolean
  externalizedScratchpad: boolean
}

export interface DeveloperModeConfig {
  enabled: boolean
  controlMode: ControlMode
  penaltyLevel: PenaltyLevel
  webSearchFirst: boolean
  webBrowseEnabled: boolean
  webFetchEnabled: boolean
  webSearchEnabled: boolean
  ragEnabled: boolean
  skillsEnabled: boolean
  mcpServersEnabled: boolean
  workflowsEnabled: boolean
  automationsEnabled: boolean
  todoEnabled: boolean
  clarificationRequired: boolean
  stepByStep: boolean
  observeMistakes: boolean
  parallelSubagents: boolean
  maxSubagents: number
  subagentMonitorIntervalMs: number
  sotaEnabled: boolean
  gateEnabled: boolean
  cotChain: CotChainSubMenu
  /**
   * Backend decision model for LOCAL primary models (ollama / llama.cpp).
   * Empty provider/model = disabled; the heuristic penalty log stays in
   * charge. Consulted once per new-mistake turn via `runSupervisorDecision`.
   */
  localSupervisor: LocalSupervisorConfig
}

/**
 * Providers whose samplers the penalty tuning exists for: the weak LOCAL
 * backends (ollama / llama.cpp). Every hosted flagship API — and anything
 * else, including custom remote gateways — is steady on its own and must
 * never inherit another backend's mistake log. Omitted (legacy callers,
 * tests) keeps the old behavior: penalties apply.
 */
export function isLocalProvider(provider?: string): boolean {
  const p = (provider ?? "").toLowerCase()
  if (p === "") return true
  return p === "ollama" || p === "llamacpp" || p === "llama.cpp"
}

export const DEFAULT_DEVELOPER_MODE_CONFIG: DeveloperModeConfig = {
  enabled: false,
  controlMode: "general",
  penaltyLevel: 1,
  webSearchFirst: true,
  webBrowseEnabled: true,
  webFetchEnabled: false,
  webSearchEnabled: true,
  ragEnabled: true,
  skillsEnabled: true,
  mcpServersEnabled: true,
  workflowsEnabled: true,
  automationsEnabled: true,
  todoEnabled: true,
  clarificationRequired: true,
  stepByStep: true,
  observeMistakes: true,
  parallelSubagents: true,
  maxSubagents: 3,
  subagentMonitorIntervalMs: 5000,
  sotaEnabled: false,
  gateEnabled: false,
  cotChain: {
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
  },
  localSupervisor: DEFAULT_LOCAL_SUPERVISOR_CONFIG,
}
export interface MistakeRecord {
  id: string
  timestamp: number
  type: "tool_error" | "hallucination" | "loop" | "wrong_tool" | "wrong_path" | "model_error"
  description: string
  severity: 1 | 2 | 3 | 4 | 5
  context: Record<string, unknown>
  resolved: boolean
}

export interface SubagentTask {
  id: string
  name: string
  prompt: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  result?: string
  error?: string
  startedAt?: number
  finishedAt?: number
  parentId?: string
  peerId?: string
}

export interface StepPlan {
  steps: Array<{
    id: string
    description: string
    status: "pending" | "in_progress" | "completed" | "failed" | "skipped"
    result?: string
    dependsOn?: string[]
  }>
  currentStepIndex: number
  completed: boolean
}

export interface ClarificationQuestion {
  id: string
  question: string
  options?: Array<{ label: string; value: string }>
  context: string
  resolved: boolean
  answer?: string
}

export interface PenaltyRecord {
  level: PenaltyLevel
  reason: string
  timestamp: number
  applied: boolean
  adjustments: Record<string, number | string | boolean>
}

export class DeveloperModeEngine {
  readonly config: DeveloperModeConfig
  private mistakes: MistakeRecord[] = []
  private penalties: PenaltyRecord[] = []
  /**
   * Absolute penalty values decided by the backend supervisor LLM for
   * local runs. These WIN per-key over the summed heuristic penalties
   * (a decision is an absolute value, not an increment).
   */
  private supervisorOverrides: Record<string, number | string | boolean> = {}
  /** mistakes.length at the last accepted supervisor decision (skip re-ask). */
  private supervisorDecidedAtCount = -1
  private subagents: Map<string, SubagentTask> = new Map()
  private stepPlans: Map<string, StepPlan> = new Map()
  private clarifications: Map<string, ClarificationQuestion> = new Map()
  private ragCache: Map<string, { text: string; embedding: number[]; timestamp: number }> = new Map()
  private workflowDefs: Map<string, Array<Record<string, unknown>>> = new Map()
  private mistakeLogPath: string
  private penaltyLogPath: string
  private subagentLogPath: string

  constructor(cwd: string, config: Partial<DeveloperModeConfig> = {}) {
    const parsedConfig = { ...config }
    // Config may arrive pre-serialized (cotChain encoded as a JSON string);
    // decode it before merging so the engine always sees the object form.
    const chainOverride: unknown = parsedConfig.cotChain
    if (typeof chainOverride === "string") {
      try {
        parsedConfig.cotChain = JSON.parse(chainOverride) as CotChainSubMenu
      } catch {
        parsedConfig.cotChain = DEFAULT_DEVELOPER_MODE_CONFIG.cotChain
      }
    }
    // The supervisor block may arrive pre-serialized too (CLI flags, env
    // bridges); decode before sanitizing so bad values fall back to the
    // defaults instead of throwing.
    const supOverride: unknown = parsedConfig.localSupervisor
    let supDecoded: unknown = parsedConfig.localSupervisor
    if (typeof supOverride === "string") {
      try {
        supDecoded = JSON.parse(supOverride)
      } catch {
        supDecoded = DEFAULT_LOCAL_SUPERVISOR_CONFIG
      }
    }
    this.config = {
      ...DEFAULT_DEVELOPER_MODE_CONFIG,
      ...parsedConfig,
      // Decoded strings (and partial objects) must merge OVER the defaults,
      // not replace them — otherwise untouched fields (maxDepth) vanish.
      cotChain: {
        ...DEFAULT_DEVELOPER_MODE_CONFIG.cotChain,
        ...((parsedConfig.cotChain as Partial<CotChainSubMenu> | undefined) ?? {}),
      },
      localSupervisor: sanitizeSupervisorConfig(supDecoded),
    }
    const devDir = path.join(cwd, "nemo", "12-control", "devmode")
    fs.mkdirSync(devDir, { recursive: true })
    this.mistakeLogPath = path.join(devDir, "mistakes.json")
    this.penaltyLogPath = path.join(devDir, "penalties.json")
    this.subagentLogPath = path.join(devDir, "subagents.json")
    this.loadPersisted()
  }

  private loadPersisted(): void {
    try {
      if (fs.existsSync(this.mistakeLogPath)) {
        const data = JSON.parse(fs.readFileSync(this.mistakeLogPath, "utf8")) as MistakeRecord[]
        this.mistakes = data.filter((m) => !m.resolved)
      }
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(this.penaltyLogPath)) {
        const data = JSON.parse(fs.readFileSync(this.penaltyLogPath, "utf8")) as PenaltyRecord[]
        this.penalties = data
      }
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(this.subagentLogPath)) {
        const data = JSON.parse(fs.readFileSync(this.subagentLogPath, "utf8")) as SubagentTask[]
        for (const s of data) this.subagents.set(s.id, s)
      }
    } catch {
      /* ignore */
    }
  }

  private persistMistakes(): void {
    try {
      fs.writeFileSync(this.mistakeLogPath, JSON.stringify(this.mistakes, null, 2))
    } catch {
      /* ignore */
    }
  }

  private persistPenalties(): void {
    try {
      fs.writeFileSync(this.penaltyLogPath, JSON.stringify(this.penalties, null, 2))
    } catch {
      /* ignore */
    }
  }

  private persistSubagents(): void {
    try {
      const data = Array.from(this.subagents.values())
      fs.writeFileSync(this.subagentLogPath, JSON.stringify(data, null, 2))
    } catch {
      /* ignore */
    }
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  getControlMode(): ControlMode {
    return this.config.controlMode
  }

  getPenaltyLevel(): PenaltyLevel {
    return this.config.penaltyLevel
  }

  isGateEnabled(): boolean {
    return this.config.gateEnabled
  }

  isSotaEnabled(): boolean {
    return this.config.sotaEnabled
  }

  toggleSota(value: boolean): void {
    this.config.sotaEnabled = value
  }

  getCotChainConfig(): CotChainSubMenu {
    return { ...this.config.cotChain }
  }

  toggleCotChain(value: boolean): void {
    this.config.cotChain.enabled = value
    if (value) this.config.sotaEnabled = true
  }

  updateCotConfig(patch: Partial<CotChainSubMenu>): void {
    this.config.cotChain = { ...this.config.cotChain, ...patch }
  }

  isCotChainEnabled(): boolean {
    return this.config.cotChain.enabled
  }

  getActivePenaltyCount(): number {
    return this.penalties.filter((p) => p.applied).length
  }

  getUnresolvedMistakeCount(): number {
    return this.mistakes.filter((m) => !m.resolved).length
  }

  recordMistake(record: Omit<MistakeRecord, "id" | "timestamp" | "resolved">): void {
    const entry: MistakeRecord = {
      ...record,
      id: `mistake_${Date.now()}_${this.mistakes.length}`,
      timestamp: Date.now(),
      resolved: false,
    }
    this.mistakes.push(entry)
    this.persistMistakes()
    if (this.config.observeMistakes) {
      this.applyPenaltyFromMistake(entry)
    }
  }

  resolveMistake(id: string): boolean {
    const m = this.mistakes.find((x) => x.id === id)
    if (m) {
      m.resolved = true
      this.persistMistakes()
      return true
    }
    return false
  }

  private applyPenaltyFromMistake(mistake: MistakeRecord): void {
    const level = Math.min(5, mistake.severity) as PenaltyLevel
    const adjustments: Record<string, number | string | boolean> = {}
    if (level >= 2) adjustments.temperature = +(this.getControlMode() === "accurate" ? 0.05 : 0.1).toFixed(3)
    if (level >= 3) adjustments.maxToolCalls = Math.max(1, 10 - level)
    if (level >= 4) adjustments.webSearchFirst = true
    if (level >= 5) {
      adjustments.clarificationRequired = true
      adjustments.stepByStep = true
    }
    const penalty: PenaltyRecord = {
      level,
      reason: `mistake: ${mistake.type} - ${mistake.description}`,
      timestamp: Date.now(),
      applied: true,
      adjustments,
    }
    this.penalties.push(penalty)
    this.persistPenalties()
  }

  getActivePenaltyAdjustments(): Record<string, number | string | boolean> {
    const active = this.penalties.filter((p) => p.applied)
    const merged: Record<string, number | string | boolean> = {}
    for (const p of active) {
      for (const [k, v] of Object.entries(p.adjustments)) {
        if (k === "temperature") {
          // Round: 0.1 + 0.1 is 0.200000000000000011 in IEEE floats, and
          // consumers compare exact budgets — same 3-decimal convention as
          // the per-mistake setter above.
          merged.temperature = +Math.max(0, Number(merged.temperature ?? 0) + Number(v)).toFixed(3)
        } else if (k === "maxToolCalls") {
          merged.maxToolCalls = Math.min(Number(merged.maxToolCalls ?? 10), Number(v))
        } else {
          merged[k] = v
        }
      }
    }
    // Supervisor decisions are absolute: they replace (not add to) the
    // heuristic value for every key they set.
    return { ...merged, ...this.supervisorOverrides }
  }

  /**
   * Apply a backend supervisor decision (local runs only — the agent
   * gates on `isLocalProvider` before requesting one). Numeric knobs are
   * clamped twice: the parser already clamps, this is the last line of
   * defense before the values reach config overrides / the wire.
   * Boolean knobs are mirrored into `config` because the runtime reads
   * them there directly (system-prompt suffix, agent-loop stepByStep).
   */
  applySupervisorDecision(decision: SupervisorDecision): void {
    const overrides: Record<string, number | string | boolean> = {}
    if (typeof decision.temperature === "number" && Number.isFinite(decision.temperature)) {
      overrides.temperature = +Math.min(2, Math.max(0, decision.temperature)).toFixed(3)
    }
    if (typeof decision.maxToolCalls === "number" && Number.isFinite(decision.maxToolCalls)) {
      overrides.maxToolCalls = Math.min(64, Math.max(1, Math.round(decision.maxToolCalls)))
    }
    if (typeof decision.webSearchFirst === "boolean") {
      overrides.webSearchFirst = decision.webSearchFirst
      this.config.webSearchFirst = decision.webSearchFirst
    }
    if (typeof decision.clarificationRequired === "boolean") {
      overrides.clarificationRequired = decision.clarificationRequired
      this.config.clarificationRequired = decision.clarificationRequired
    }
    if (typeof decision.stepByStep === "boolean") {
      overrides.stepByStep = decision.stepByStep
      this.config.stepByStep = decision.stepByStep
    }
    this.supervisorOverrides = overrides
  }

  /**
   * Ask the backend decision LLM to (re)choose penalties for a local
   * run. Gated: devmode on, supervisor configured, and at least one NEW
   * mistake since the last accepted decision (no new information = no
   * paid request). Returns null on every failure path — fail-open, the
   * heuristic penalties stay in charge.
   */
  async runSupervisorDecision(opts?: {
    signal?: AbortSignal
    /** Injection seam for tests; defaults to the core provider registry. */
    createProvider?: (providerId: string, options: ProviderOptions) => Provider | undefined
  }): Promise<SupervisorDecision | null> {
    if (!this.config.enabled) return null
    const supervisor = this.config.localSupervisor
    if (!isSupervisorConfigured(supervisor)) return null
    if (this.mistakes.length === 0) return null
    if (this.mistakes.length === this.supervisorDecidedAtCount) return null
    const decision = await requestSupervisorDecision({
      supervisor,
      mistakes: this.mistakes,
      currentAdjustments: this.getActivePenaltyAdjustments(),
      signal: opts?.signal,
      createProvider: opts?.createProvider,
    })
    if (!decision) return null
    this.applySupervisorDecision(decision)
    this.supervisorDecidedAtCount = this.mistakes.length
    return decision
  }

  createClarification(
    question: string,
    context: string,
    options?: Array<{ label: string; value: string }>,
  ): ClarificationQuestion {
    const id = `clarify_${Date.now().toString(36)}_${this.clarifications.size}`
    const entry: ClarificationQuestion = { id, question, options, context, resolved: false }
    this.clarifications.set(id, entry)
    return entry
  }

  resolveClarification(id: string, answer: string): boolean {
    const c = this.clarifications.get(id)
    if (c) {
      c.resolved = true
      c.answer = answer
      return true
    }
    return false
  }

  getPendingClarifications(): ClarificationQuestion[] {
    return Array.from(this.clarifications.values()).filter((c) => !c.resolved)
  }

  needsClarification(prompt: string): boolean {
    if (!this.config.enabled || !this.config.clarificationRequired) return false
    const lower = prompt.toLowerCase().trim()
    const vaguePatterns = [
      /\b(build|create|make|write|develop|design|setup|set up|fix|implement|generate|scaffold)\b.*\b(a|an|the)?\s*(website|app|application|project|tool|script|program|code|api|bot|system|platform|page|component|feature)\b/i,
      /\b(website|app|application|project|tool|script|program|code|api|bot|system|platform)\b.*\b(for me|please|help me|i need|i want)\b/i,
      /\b(build|create|make)\b.*\b(something|anything|stuff|thing)\b/i,
      /\b(help me)\b/i,
      /\b(i need)\b.*\b(help|a|an|the)\b/i,
    ]
    const hasDetails =
      /\b(using|with|in|for|on|to|from|by|react|vue|node|python|javascript|typescript|css|html|database|api|rest|graphql|sql|mongodb|postgres|docker|aws|azure|gcp|vercel|netlify|next|express|fastapi|django|flask|tailwind|bootstrap|sass|scss|json|xml|yaml|toml)\b/i
    if (hasDetails.test(lower)) return false
    const wordCount = lower.split(/\s+/).filter(Boolean).length
    if (wordCount > 15) return false
    return vaguePatterns.some((re) => re.test(lower))
  }

  analyzePrompt(prompt: string): ClarificationQuestion[] {
    if (!this.config.enabled || !this.config.clarificationRequired) return []
    const lower = prompt.toLowerCase().trim()
    const questions: ClarificationQuestion[] = []

    if (/\b(website|site|page|web)\b/i.test(lower)) {
      questions.push({
        id: `clarify_${Date.now().toString(36)}_type`,
        question: "What type of website do you need?",
        context: prompt,
        options: [
          { label: "Portfolio / Personal", value: "portfolio" },
          { label: "E-commerce / Store", value: "ecommerce" },
          { label: "Blog / CMS", value: "blog" },
          { label: "Landing Page", value: "landing" },
          { label: "Dashboard / Admin", value: "dashboard" },
          { label: "Documentation", value: "docs" },
        ],
        resolved: false,
      })
      questions.push({
        id: `clarify_${Date.now().toString(36)}_stack`,
        question: "Which tech stack should I use?",
        context: prompt,
        options: [
          { label: "HTML + CSS + JS (vanilla)", value: "vanilla" },
          { label: "React + Vite", value: "react" },
          { label: "Next", value: "nextjs" },
          { label: "Vue + Vite", value: "vue" },
          { label: "Any / You decide", value: "any" },
        ],
        resolved: false,
      })
    }

    if (/\b(app|application|mobile|ios|android)\b/i.test(lower) && !/\b(website|web|site)\b/i.test(lower)) {
      questions.push({
        id: `clarify_${Date.now().toString(36)}_platform`,
        question: "Which platform should I target?",
        context: prompt,
        options: [
          { label: "Web app (browser)", value: "web" },
          { label: "Mobile (React Native)", value: "mobile" },
          { label: "Desktop (Electron / Tauri)", value: "desktop" },
          { label: "Cross-platform (Flutter)", value: "flutter" },
        ],
        resolved: false,
      })
    }

    if (/\b(api|backend|server|endpoint)\b/i.test(lower)) {
      questions.push({
        id: `clarify_${Date.now().toString(36)}_api_stack`,
        question: "Which backend stack should I use?",
        context: prompt,
        options: [
          { label: "Node + Express", value: "node" },
          { label: "Python + FastAPI", value: "fastapi" },
          { label: "Python + Django", value: "django" },
          { label: "Go + Gin", value: "go" },
          { label: "Any / You decide", value: "any" },
        ],
        resolved: false,
      })
    }

    if (/\b(bot|automation|script|tool)\b/i.test(lower)) {
      questions.push({
        id: `clarify_${Date.now().toString(36)}_bot_platform`,
        question: "Where should this run?",
        context: prompt,
        options: [
          { label: "Discord bot", value: "discord" },
          { label: "Telegram bot", value: "telegram" },
          { label: "CLI / Terminal", value: "cli" },
          { label: "Web service", value: "web" },
        ],
        resolved: false,
      })
    }

    if (questions.length === 0) {
      questions.push({
        id: `clarify_${Date.now().toString(36)}_scope`,
        question: "Can you provide more details about what you want to build?",
        context: prompt,
        options: [
          { label: "Start from scratch", value: "scratch" },
          { label: "Extend existing code", value: "extend" },
          { label: "Fix a bug / issue", value: "fix" },
          { label: "Refactor / improve", value: "refactor" },
        ],
        resolved: false,
      })
    }

    return questions.slice(0, 3)
  }

  createStepPlan(goal: string): StepPlan {
    const id = `plan_${Date.now().toString(36)}`
    const plan: StepPlan = {
      steps: [{ id: `${id}_step_1`, description: goal, status: "pending" }],
      currentStepIndex: 0,
      completed: false,
    }
    this.stepPlans.set(id, plan)
    return plan
  }

  expandStepPlan(planId: string, steps: Array<{ description: string; dependsOn?: string[] }>): StepPlan | undefined {
    const plan = this.stepPlans.get(planId)
    if (!plan) return undefined
    plan.steps = steps.map((s, i) => ({
      id: `${planId}_step_${i + 1}`,
      description: s.description,
      status: "pending" as const,
      dependsOn: s.dependsOn,
    }))
    plan.currentStepIndex = 0
    return plan
  }

  advanceStepPlan(planId: string): { step: StepPlan["steps"][number]; plan: StepPlan } | undefined {
    const plan = this.stepPlans.get(planId)
    if (!plan || plan.completed) return undefined
    const idx = plan.currentStepIndex
    if (idx >= plan.steps.length) {
      plan.completed = true
      return undefined
    }
    const step = plan.steps[idx]
    step.status = "in_progress"
    return { step, plan }
  }

  completeStep(planId: string, stepId: string, result: string): boolean {
    const plan = this.stepPlans.get(planId)
    if (!plan) return false
    const step = plan.steps.find((s) => s.id === stepId)
    if (!step) return false
    step.status = "completed"
    step.result = result
    plan.currentStepIndex++
    if (plan.currentStepIndex >= plan.steps.length) {
      plan.completed = true
    }
    return true
  }

  failStep(planId: string, stepId: string, error: string): boolean {
    const plan = this.stepPlans.get(planId)
    if (!plan) return false
    const step = plan.steps.find((s) => s.id === stepId)
    if (!step) return false
    step.status = "failed"
    step.result = error
    return true
  }

  getStepPlan(planId: string): StepPlan | undefined {
    return this.stepPlans.get(planId)
  }

  startSubagent(name: string, prompt: string, parentId?: string, peerId?: string): SubagentTask {
    const id = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const task: SubagentTask = {
      id,
      name,
      prompt,
      status: "pending",
      parentId,
      peerId,
    }
    this.subagents.set(id, task)
    this.persistSubagents()
    return task
  }

  updateSubagent(id: string, patch: Partial<SubagentTask>): boolean {
    const task = this.subagents.get(id)
    if (!task) return false
    Object.assign(task, patch, { startedAt: task.startedAt ?? Date.now() })
    this.persistSubagents()
    return true
  }

  completeSubagent(id: string, result: string): boolean {
    return this.updateSubagent(id, { status: "completed", result, finishedAt: Date.now() })
  }

  failSubagent(id: string, error: string): boolean {
    return this.updateSubagent(id, { status: "failed", error, finishedAt: Date.now() })
  }

  cancelSubagent(id: string): boolean {
    return this.updateSubagent(id, { status: "cancelled", finishedAt: Date.now() })
  }

  getSubagent(id: string): SubagentTask | undefined {
    return this.subagents.get(id)
  }

  getActiveSubagents(): SubagentTask[] {
    return Array.from(this.subagents.values()).filter((s) => s.status === "pending" || s.status === "running")
  }

  getAllSubagents(): SubagentTask[] {
    return Array.from(this.subagents.values())
  }

  crossMonitorSubagents(): Array<{ agentA: SubagentTask; agentB: SubagentTask; status: string }> {
    const all = this.getAllSubagents()
    const pairs: Array<{ agentA: SubagentTask; agentB: SubagentTask; status: string }> = []
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]
        const b = all[j]
        if (a.peerId === b.id || b.peerId === a.id || a.parentId === b.parentId) {
          let status = "independent"
          if (a.status === "failed" || b.status === "failed") status = "blocked"
          else if (a.status === "completed" && b.status === "completed") status = "both_done"
          else if (a.status === "running" && b.status === "running") status = "parallel_active"
          pairs.push({ agentA: a, agentB: b, status })
        }
      }
    }
    return pairs
  }

  addToRagCache(key: string, text: string, embedding: number[]): void {
    if (!this.config.ragEnabled) return
    this.ragCache.set(key, { text, embedding, timestamp: Date.now() })
  }

  getFromRagCache(key: string): { text: string; embedding: number[]; timestamp: number } | undefined {
    return this.ragCache.get(key)
  }

  searchRagCache(queryEmbedding: number[], topK = 5): Array<{ key: string; text: string; score: number }> {
    if (!this.config.ragEnabled) return []
    const results: Array<{ key: string; text: string; score: number }> = []
    for (const [key, entry] of this.ragCache) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding)
      results.push({ key, text: entry.text, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  registerWorkflow(name: string, steps: Array<Record<string, unknown>>): void {
    if (!this.config.workflowsEnabled) return
    this.workflowDefs.set(name, steps)
  }

  getWorkflow(name: string): Array<Record<string, unknown>> | undefined {
    return this.workflowDefs.get(name)
  }

  listWorkflows(): string[] {
    return Array.from(this.workflowDefs.keys())
  }

  getSystemPromptSuffix(): string {
    if (!this.config.enabled) return ""
    const lines: string[] = []
    lines.push("")
    lines.push("=== DEVELOPER MODE ACTIVE ===")
    lines.push(`Control Mode: ${this.config.controlMode.toUpperCase()}`)
    lines.push(`Penalty Level: ${this.config.penaltyLevel}/5`)
    lines.push("")
    if (this.config.clarificationRequired) {
      lines.push("CLARIFICATION PROTOCOL:")
      lines.push("  - Before executing any multi-step task, ask clarifying questions.")
      lines.push("  - When the request is ambiguous, list 2-4 specific options and wait.")
      lines.push("  - Never proceed with assumptions when critical parameters are missing.")
      lines.push("")
    }
    if (this.config.stepByStep) {
      lines.push("STEP-BY-STEP EXECUTION:")
      lines.push("  - Break every task into explicit numbered steps.")
      lines.push("  - State the plan before executing.")
      lines.push("  - Confirm each step's completion before moving to the next.")
      lines.push("  - Use the todo tool to track progress.")
      lines.push("")
    }
    if (this.config.observeMistakes) {
      lines.push("MISTAKE OBSERVATION:")
      lines.push("  - Note every error, failed tool call, or wrong assumption.")
      lines.push("  - Record mistakes even when recovering from them.")
      lines.push("  - Do not hide or skip over errors - surface them explicitly.")
      lines.push("")
    }
    if (this.config.parallelSubagents) {
      lines.push("PARALLEL SUBAGENTS:")
      lines.push(`  - You may spawn up to ${this.config.maxSubagents} parallel subagents.`)
      lines.push("  - Monitor peer subagent progress and adjust if one fails.")
      lines.push("  - Cross-reference results between agents.")
      lines.push("")
    }
    if (!this.config.webFetchEnabled) {
      lines.push("WEB FETCH:")
      lines.push("  - web_fetch is DISABLED by default for safety.")
      lines.push("  - When enabled, use only for trusted sources and explicit user requests.")
      lines.push("  - Never fetch arbitrary URLs without user consent.")
      lines.push("")
    }
    if (this.config.workflowsEnabled) {
      lines.push("WORKFLOWS:")
      lines.push("  - Recognize repeated patterns and suggest or execute workflows.")
      lines.push("  - Automate multi-step sequences when the same task recurs.")
      lines.push("")
    }
    lines.push("=== END DEVELOPER MODE ===")
    lines.push("")
    return lines.join("\n")
  }

  getToolPriority(): string[] {
    const priority: string[] = []
    if (this.config.webSearchFirst) {
      priority.push("web_search")
    }
    if (this.config.webBrowseEnabled) {
      priority.push("web_fetch")
    }
    if (this.config.ragEnabled) {
      priority.push("rag_query")
      priority.push("rag_store")
    }
    if (this.config.todoEnabled) {
      priority.push("todo")
    }
    if (this.config.skillsEnabled) {
      priority.push("skill__")
    }
    if (this.config.mcpServersEnabled) {
      priority.push("mcp__")
    }
    return priority
  }

  reorderTools(tools: Tool[]): Tool[] {
    if (!this.config.enabled) return tools
    const priority = this.getToolPriority()
    const priorityTools: Tool[] = []
    const normalTools: Tool[] = []
    for (const tool of tools) {
      const name = tool.definition.name
      const isPriority = priority.some((p) => name.startsWith(p))
      if (isPriority) {
        priorityTools.push(tool)
      } else {
        normalTools.push(tool)
      }
    }
    return [...priorityTools, ...normalTools]
  }

  getConfigOverrides(opts?: { provider?: string }): Record<string, number | string | boolean> {
    const overrides: Record<string, number | string | boolean> = {}
    const mode = this.config.controlMode
    if (mode === "accurate") {
      overrides.temperature = 0
      overrides.topP = 0.8
      overrides.maxTokens = 8192
    } else {
      overrides.temperature = 0.2
      overrides.topP = 0.9
      overrides.maxTokens = 4096
    }
    // Penalties tune weak LOCAL samplers only (ollama / llama.cpp —
    // isLocalProvider): hosted flagship APIs ignore them entirely. The
    // penalty log is backend-blind, so without this gate, mistakes made
    // under a local model piled +0.1s onto the override until NVIDIA calls
    // carried temperature 2.7 (observed live: HTTP 400 + multilingual
    // mush). Omitted provider keeps the legacy behavior (penalties apply).
    const penaltyAdj = isLocalProvider(opts?.provider) ? this.getActivePenaltyAdjustments() : {}
    if (penaltyAdj.temperature !== undefined) {
      // Ceiling: per-mistake +0.05/+0.1 adjustments accumulate WITHOUT bound
      // and persist across restarts (~25 mistakes ≈ 2.7 → provider HTTP 400
      // or max-temperature babble, observed live). The damp is a nudge, so
      // cap it at the widest backend ceiling (providers clamp to their own
      // maxima anyway).
      overrides.temperature = Math.min(2, Math.max(0, Number(penaltyAdj.temperature)))
    }
    if (penaltyAdj.maxToolCalls !== undefined) {
      overrides.maxToolCalls = Math.max(1, Number(penaltyAdj.maxToolCalls))
    }
    if (penaltyAdj.webSearchFirst !== undefined) {
      overrides.webSearchFirst = Boolean(penaltyAdj.webSearchFirst)
    }
    if (penaltyAdj.clarificationRequired !== undefined) {
      overrides.clarificationRequired = Boolean(penaltyAdj.clarificationRequired)
    }
    if (penaltyAdj.stepByStep !== undefined) {
      overrides.stepByStep = Boolean(penaltyAdj.stepByStep)
    }
    overrides.sotaEnabled = this.config.sotaEnabled
    overrides.gateEnabled = this.config.gateEnabled
    overrides.enabled = this.config.enabled
    return overrides
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  magA = Math.sqrt(magA)
  magB = Math.sqrt(magB)
  if (magA === 0 || magB === 0) return 0
  return dot / (magA * magB)
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import type { AgentEventSink, AgentMessage, AssistantMessage } from "../../../../packages/protocol/src/index.js"
import {
  createLlamaCppProvider,
  createNvidiaProvider,
  createOpenAIProvider,
  createXAIProvider,
  createHuggingFaceProvider,
  createCustomProvider,
  createAnthropicProvider,
  createGoogleProvider,
  createOllamaProvider,
  type Provider,
  type ProviderOptions,
  type WireMessage,
} from "../../../../packages/provider/src/index.js"
import type { TrayambakConfig } from "../config.js"
import { buildSystemPrompt } from "../prompt/power-prompt.js"
import { Session } from "../session/session.js"
import { createDefaultTools, buildOptionalTools, toolDefinitions, getContextBlock, type Tool } from "../tools/index.js"
import { getSktContextBlock } from "../../../../skt/context.js"
import { getRulesContextBlock } from "../prompt/rules.js"
import { DeveloperModeEngine, DEFAULT_DEVELOPER_MODE_CONFIG } from "../developer-mode/index.js"
import { SotaDevMode } from "../developer-mode/sota-mode.js"
import { runAgentLoop } from "./agent-loop.js"
import type { GoalStore } from "../goals.js"
import type { SelfImprovementStore } from "../self-improvement.js"
import { HarnessRuntime, type HarnessPlugin } from "../../../../packages/harness/src/index.js"
import { discoverAgentProfiles, getAgentProfile, type AgentProfile } from "./specialist-agents.js"
import { DEFAULT_PERMISSIONS } from "../../../../packages/protocol/src/permissions.js"
import { Arsenal } from "../../../../packages/core/src/toolsets/arsenal.js"

const exec = promisify(execFile)

/**
 * Wrap an event sink so every event emitted by a child (subagent) loop is
 * tagged with the subagent that produced it. UIs use the tag to route nested
 * tool/streaming activity to the subagent's card instead of the parent
 * transcript (SKT AI LABS renders nested parts under the task card; Ink flattens).
 * Object.assign keeps the result assignable to AgentEventSink without casts.
 */
function tagSubagentEmit(emit: AgentEventSink, subagentId: string, subagentName: string): AgentEventSink {
  return (event) => {
    // Lifecycle events already carry their own subagentId (e.g. a nested
    // subagent started by this one) — never re-attribute them to this id.
    if (event.subagentId !== undefined) return emit(event)
    return emit(Object.assign({}, event, { subagentId, subagentName }))
  }
}

export interface SubagentRunTask {
  name: string
  prompt: string
  subagentType?: string
  model?: string
  isolation?: string
  background?: boolean
}

export type SubagentRunner = (
  task: {
    name: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
    background?: boolean
  },
  emit: AgentEventSink,
) => Promise<{ text: string; error?: string }>

/**
 * Result type for runSubagents, includes background tracking info.
 */
export type SubagentResult = { name: string; text: string; error?: string; background?: boolean; subagentId?: string }

/**
 * Background job info for tracking asynchronous subagent tasks.
 */
export interface BackgroundSubagentInfo {
  id: string
  name: string
  prompt: string
  subagentType?: string
  model?: string
  isolation?: string
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
}

export interface AgentOptions {
  config: TrayambakConfig
  tools?: Tool[]
  sessionFile?: string
  sessionId?: string
  /** Durable-inbox id this agent's loop polls each turn (SendMessage delivery). */
  inboxId?: string
  developerMode?: Partial<typeof DEFAULT_DEVELOPER_MODE_CONFIG>
  mode?: string
  specialistPrompt?: string
  plugins?: HarnessPlugin[]
  subagentDepth?: number
  subagentRunner?: SubagentRunner
  onAskUserQuestion?: (
    questions: Array<{
      question: string
      header?: string
      options: Array<{ label: string; description?: string }>
      multi_select: boolean
    }>,
  ) => Promise<string[]>
  onRequestPermission?: (tool: string, args: unknown, reason: string) => Promise<boolean>
}

export class Agent {
  readonly config: TrayambakConfig
  readonly provider: Provider
  tools: Tool[]
  session: Session
  sessionId?: string
  developerMode: DeveloperModeEngine
  private readonly sessionFile?: string
  private goalStore?: GoalStore
  private selfImprovement?: SelfImprovementStore
  private readonly plugins: HarnessPlugin[]
  private readonly subagentDepth: number
  readonly harness: HarnessRuntime
  mode: string
  readonly specialistPrompt?: string
  private sotaMode?: SotaDevMode
  private arsenal?: Arsenal<Tool>
  private readonly onAskUserQuestion?: AgentOptions["onAskUserQuestion"]
  private readonly onRequestPermission?: AgentOptions["onRequestPermission"]
  private readonly subagentRunner?: SubagentRunner
  private currentSignal?: AbortSignal
  private currentEmit?: AgentEventSink
  private backgroundJobs: Map<string, BackgroundSubagentInfo> = new Map()
  private backgroundEmit?: AgentEventSink
  /** Durable-inbox id polled by this agent's loop (see RunConfig.inboxId). */
  private readonly inboxId?: string
  /** Per-job abort controllers: background loops used to run with an
   *  `undefined` signal, making them unabortable (Ctrl+D only aborted the
   *  foreground controller). Cancel via cancelBackgroundJob(). */
  private backgroundControllers: Map<string, AbortController> = new Map()

  constructor(options: AgentOptions) {
    this.config = options.config
    this.subagentDepth = options.subagentDepth ?? 0
    this.specialistPrompt = options.specialistPrompt
    this.mode = options.mode ?? "default"
    this.plugins = options.plugins ?? []
    this.harness = new HarnessRuntime(this.config.cwd)
    this.onAskUserQuestion = options.onAskUserQuestion
    this.onRequestPermission = options.onRequestPermission
    this.subagentRunner = options.subagentRunner
    this.sessionId = options.sessionId ?? ""
    this.inboxId = options.inboxId
    const devConfig = { ...(options.config.developerMode ?? {}), ...(options.developerMode ?? {}) }
    const { tools, arsenal } =
      options.tools && options.tools.length > 0
        ? { tools: options.tools, arsenal: undefined }
        : createDefaultTools(
            devConfig,
            (params) => this.runSubagentRequest(params),
            (tasks) => this.runSubagents(tasks),
            options.onAskUserQuestion,
            this.config,
            (to) => this.resolveSendMessageTarget(to),
          )
    this.tools = tools
    if (arsenal) {
      this.arsenal = arsenal
    }
    this.developerMode = new DeveloperModeEngine(this.config.cwd, devConfig)
    const devOverrides = this.developerMode.getConfigOverrides()
    const temperature = (
      devOverrides.temperature !== undefined ? Number(devOverrides.temperature) : this.config.temperature
    ) as number
    const topP = (devOverrides.topP !== undefined ? Number(devOverrides.topP) : this.config.topP) as number
    const maxTokens = (
      devOverrides.maxTokens !== undefined ? Number(devOverrides.maxTokens) : this.config.maxTokens
    ) as number
    this.provider = this.createProviderForConfig({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      temperature,
      topP,
      maxTokens,
      timeoutMs: this.config.timeoutMs,
      reasoningEffort: this.config.reasoningEffort,
    })
    this.session = options.sessionFile ? (Session.load(options.sessionFile) ?? new Session()) : new Session()
    const reorderedTools = this.developerMode.isEnabled() ? this.developerMode.reorderTools(this.tools) : this.tools
    const specialistBlock = this.specialistPrompt
      ? `\n## SPECIALIST ROLE & INSTRUCTIONS\n${this.specialistPrompt}\n`
      : ""
    this.session.setSystemPrompt(
      buildSystemPrompt({
        cwd: this.config.cwd,
        model: this.config.model,
        nativeTools: this.config.nativeTools,
        tools: toolDefinitions(reorderedTools),
        memoryBlock: getContextBlock(),
        developerModeSuffix: this.developerMode.getSystemPromptSuffix(),
        modeSuffix: specialistBlock + modeSystemPromptSuffix(this.mode),
        sktBlock: getSktContextBlock(),
        rulesBlock: getRulesContextBlock(this.config.cwd),
      }),
    )
    if (this.config.scratchpadDir) {
      try {
        fs.mkdirSync(this.config.scratchpadDir, { recursive: true })
      } catch {
        /* ignore scratchpad creation errors */
      }
    }
  }

  private createProviderForConfig(options: ProviderOptions): Provider {
    const provider = this.config.provider ?? "nvidia"
    if (provider === "nvidia" || provider === "nvidia-nim") {
      const baseUrl =
        options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://integrate.api.nvidia.com"
      const model = options.model && options.model.length > 0 ? options.model : "nvidia/nemotron-3-super-120b-a12b"
      return createNvidiaProvider({ ...options, baseUrl, model })
    }
    if (provider === "openai") {
      const baseUrl = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://api.openai.com"
      const model = options.model && options.model.length > 0 ? options.model : "gpt-4o"
      return createOpenAIProvider({ ...options, baseUrl, model })
    }
    if (provider === "xai") {
      const baseUrl = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://api.x.ai"
      const model = options.model && options.model.length > 0 ? options.model : "grok-4"
      return createXAIProvider({ ...options, baseUrl, model })
    }
    if (provider === "huggingface") {
      const baseUrl =
        options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://router.huggingface.co/v1"
      const model = options.model && options.model.length > 0 ? options.model : "meta-llama/Llama-3.3-70B-Instruct"
      return createHuggingFaceProvider({ ...options, baseUrl, model })
    }
    if (provider === "anthropic") {
      const baseUrl = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://api.anthropic.com"
      const model = options.model && options.model.length > 0 ? options.model : "claude-3-5-sonnet-latest"
      return createAnthropicProvider({ ...options, baseUrl, model })
    }
    if (provider === "google") {
      const baseUrl =
        options.baseUrl && options.baseUrl.length > 0
          ? options.baseUrl
          : "https://generativelanguage.googleapis.com/v1beta"
      const model = options.model && options.model.length > 0 ? options.model : "gemini-2.5-flash"
      return createGoogleProvider({ ...options, baseUrl, model })
    }
    if (provider === "ollama") {
      const baseUrl = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "http://localhost:11434"
      const model = options.model && options.model.length > 0 ? options.model : "llama3.1"
      return createOllamaProvider({ ...options, baseUrl, model })
    }
    if (provider === "custom") {
      const baseUrl = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "http://localhost:8080"
      const model = options.model ?? ""
      return createCustomProvider({ ...options, baseUrl, model })
    }
    return createLlamaCppProvider(options)
  }

  setMode(mode: string): void {
    this.mode = mode
    // Activating the SOTA / CoT reasoning mode enables the inference-time
    // reasoning machine (tree search + verifier + re-solve). The model may
    // also invoke the sota_solve tool directly.
    this.setSotaMode(mode === "sota" || mode === "cot")
    this.refreshSystemPrompt()
  }

  setGoalStore(store: GoalStore): void {
    this.goalStore = store
    this.plugins.push(store)
    this.refreshSystemPrompt()
  }

  setSelfImprovementStore(store: SelfImprovementStore): void {
    this.selfImprovement = store
    this.refreshSystemPrompt()
  }

  async registerPlugin(plugin: HarnessPlugin): Promise<void> {
    await this.harness.register(plugin)
    this.refreshSystemPrompt()
  }

  createHarnessSnapshot(label: string): string {
    return this.harness.snapshot(label)
  }

  rollbackHarnessSnapshot(id: string): void {
    this.harness.rollback(id)
    this.refreshSystemPrompt()
  }

  setSotaMode(enabled: boolean): void {
    if (!this.sotaMode && enabled) {
      const cotConfig = this.developerMode?.getCotChainConfig()
      this.sotaMode = new SotaDevMode({
        generate: async (system, messages) => {
          const response = await this.provider.chat({
            messages: [{ role: "system", content: system }, ...(messages as WireMessage[])],
          })
          const textPart = response.content.find((c) => c.type === "text")
          return textPart ? String(textPart.text) : ""
        },
        signal: undefined,
        cotChainConfig: cotConfig,
      })
    }
    if (this.sotaMode && this.developerMode?.isCotChainEnabled()) {
      this.sotaMode.setCotConfig({ enabled: true })
    }
    this.sotaMode?.toggle(enabled)
  }

  isSotaEnabled(): boolean {
    return this.sotaMode?.isEnabled() ?? false
  }

  private refreshSystemPrompt(): void {
    const baseTools = this.developerMode.isEnabled() ? this.developerMode.reorderTools(this.tools) : this.tools
    const runTools = this.arsenal ? this.arsenal.resolveTools(baseTools) : baseTools
    const specialistBlock = this.specialistPrompt
      ? `\n## SPECIALIST ROLE & INSTRUCTIONS\n${this.specialistPrompt}\n`
      : ""
    const skillTools = runTools.filter((t) => t.definition.name.startsWith("skill__"))
    const skillsBlock =
      skillTools.length > 0
        ? `Loaded Skills:\n${skillTools.map((t) => `- ${t.definition.name.replace(/^skill__/, "")}: ${t.definition.description.split("\n")[0]}`).join("\n")}`
        : ""
    this.session.setSystemPrompt(
      buildSystemPrompt({
        cwd: this.config.cwd,
        model: this.config.model,
        nativeTools: this.config.nativeTools,
        tools: toolDefinitions(runTools),
        memoryBlock: getContextBlock(),
        developerModeSuffix: this.developerMode.getSystemPromptSuffix(),
        modeSuffix: specialistBlock + modeSystemPromptSuffix(this.mode) + (this.goalStore?.context() ?? ""),
        selfImprovementBlock: this.selfImprovement?.context(),
        harnessBlock: this.harness.context(),
        rulesBlock: getRulesContextBlock(this.config.cwd),
        skillsBlock: skillsBlock || undefined,
      }),
    )
  }

  /**
   * Non-blocking construction that also loads config-driven tools
   * (MCP servers + Skills) on top of the default tool set.
   */
  static async create(options: AgentOptions): Promise<Agent> {
    const agent = new Agent(options)
    try {
      const extra = await buildOptionalTools(options.config, agent.tools, agent.arsenal)
      agent.tools = agent.arsenal ? agent.arsenal.resolveTools([...agent.tools, ...extra]) : [...agent.tools, ...extra]
      // The constructor prompt only knows default tools — rebuild it now
      // that MCP/skill tools exist, or the model never sees them.
      agent.refreshSystemPrompt()
      return agent
    } catch {
      return agent
    }
  }
  async run(prompt: string, emit: AgentEventSink, signal?: AbortSignal): Promise<AgentMessage[]> {
    this.currentSignal = signal
    this.currentEmit = emit
    for (const plugin of this.plugins) {
      await this.registerPlugin(plugin)
    }

    this.plugins.length = 0
    await this.harness.emit({ type: "turn_start", prompt })
    if (this.goalStore && !this.goalStore.get()) {
      this.goalStore.set(prompt)
      this.refreshSystemPrompt()
    }

    const isComplex =
      prompt.length > 100 || /\b(code|function|implement|debug|fix|build|create|design|plan|analyze)\b/i.test(prompt)
    if (this.sotaMode?.isEnabled() && isComplex) {
      this.sotaMode.setSignal(signal)
      const userMessage: AgentMessage = { role: "user", content: prompt }
      this.session.add(userMessage)
      try {
        const result = await this.sotaMode.runSotaReasoning(prompt)
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: result.solution }],
          stopReason: "end_turn",
        }
        this.session.add(assistant)
        await emit({ type: "message_start", message: assistant })
        await emit({ type: "message_end", message: assistant })
        await emit({ type: "agent_end", messages: this.session.messages })
        this.selfImprovement?.observe(prompt, result.solution, false)
        this.selfImprovement?.refine()
        await this.harness.emit({ type: "turn_end", prompt, success: true })
        this.refreshSystemPrompt()
        return [assistant]
      } catch (error) {
        this.selfImprovement?.observe(prompt, error instanceof Error ? error.message : String(error), true)
        this.selfImprovement?.refine()
        this.refreshSystemPrompt()
        await this.harness.emit({
          type: "error",
          prompt,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }

    let messages: AgentMessage[]
    try {
      const runTools = this.arsenal ? this.arsenal.resolveTools(this.tools) : this.tools
      const devOverrides = this.developerMode.getConfigOverrides()
      messages = await runAgentLoop(prompt, {
        onRequestPermission: this.onRequestPermission,
        provider: this.provider,
        tools: runTools,
        session: this.session,
        config: this.config,
        emit,
        signal,
        inboxId: this.inboxId,
        developerMode: this.developerMode,
        maxToolCalls:
          devOverrides.maxToolCalls !== undefined ? Number(devOverrides.maxToolCalls) : this.config.maxToolCalls,
        maxParallelToolCalls: this.config.maxParallelToolCalls,
        sessionId: this.sessionId,
      })
    } catch (error) {
      this.selfImprovement?.observe(prompt, error instanceof Error ? error.message : String(error), true)
      this.selfImprovement?.refine()
      this.refreshSystemPrompt()
      await this.harness.emit({ type: "error", prompt, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const response = [...messages].reverse().find((message) => message.role === "assistant")
    const text = response?.content.find((part) => part.type === "text")
    this.selfImprovement?.observe(prompt, text && "text" in text ? text.text : "", false)
    this.selfImprovement?.refine()
    await this.harness.emit({ type: "turn_end", prompt, success: true })
    this.refreshSystemPrompt()
    return messages
  }

  discoverAgentProfiles(): AgentProfile[] {
    return discoverAgentProfiles(this.config.cwd, this.config.agentProfileDirs)
  }

  async runSubagents(
    tasks: Array<SubagentRunTask | { name: string; prompt: string }>,
    emit: AgentEventSink = () => undefined,
  ): Promise<Array<{ name: string; text: string; error?: string; background?: boolean; subagentId?: string }>> {
    if (this.subagentDepth >= 3) throw new Error("Subagent recursion limit reached.")
    const limit = Math.max(1, Math.min(this.config.maxParallelToolCalls, this.developerMode.config.maxSubagents))
    const output: SubagentResult[] = []
    for (let i = 0; i < tasks.length; i += limit) {
      const batch = tasks.slice(i, i + limit)
      const results = await Promise.all(
        batch.map(async (task) => {
          const runTask = task as SubagentRunTask
          const subagentId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          const profile = runTask.subagentType
            ? getAgentProfile(runTask.subagentType, this.config.cwd, this.config.agentProfileDirs)
            : undefined
          const isolation = runTask.isolation ?? "inherit"
          const isBackground = runTask.background === true
          let worktreeCleanup: (() => void) | undefined
          const baseChildConfig = {
            ...this.config,
            permissions: { ...(this.config.permissions ?? DEFAULT_PERMISSIONS), askByDefault: false },
          }
          let childConfig: TrayambakConfig = baseChildConfig
          try {
            if (isolation === "worktree") {
              const wt = await createWorktreeIsolation(this.config.cwd)
              worktreeCleanup = wt.cleanup
              childConfig = { ...baseChildConfig, cwd: wt.cwd }
            }
            await emit({
              type: isBackground ? "subagent_background_start" : "subagent_start",
              subagentId,
              name: task.name,
              prompt: task.prompt,
              subagentType: runTask.subagentType,
              isolation: isolation === "worktree" ? "worktree" : undefined,
            })
            if (isBackground) {
              const jobInfo: BackgroundSubagentInfo = {
                id: subagentId,
                name: task.name,
                prompt: task.prompt,
                subagentType: runTask.subagentType,
                model: runTask.model,
                isolation,
                status: "running",
                startedAt: Date.now(),
              }
              this.backgroundJobs.set(subagentId, jobInfo)
              this.runBackgroundSubagent(
                subagentId,
                task.prompt,
                childConfig,
                profile,
                isolation,
                worktreeCleanup,
              ).catch((err) => {
                const message = err instanceof Error ? err.message : String(err)
                this.updateBackgroundJob(subagentId, { status: "error", error: message, completedAt: Date.now() })
                void emit({ type: "subagent_background_fail", subagentId, name: task.name, error: message })
              })
              return { name: task.name, text: "", background: true, subagentId }
            }
            const child = await Agent.create({
              config: childConfig,
              mode: profile?.category === "reviewer" ? "default" : "coder",
              specialistPrompt: profile?.prompt,
              subagentDepth: this.subagentDepth + 1,
              inboxId: subagentId,
              onAskUserQuestion: this.onAskUserQuestion,
              onRequestPermission: this.onRequestPermission,
              subagentRunner: this.subagentRunner,
            })
            const messages = await child.run(
              task.prompt,
              tagSubagentEmit(emit, subagentId, task.name),
              this.currentSignal,
            )
            const assistant = [...messages].reverse().find((message) => message.role === "assistant")
            const text = assistant?.content.find((part) => part.type === "text")
            const resultText = text && "text" in text ? text.text : ""
            await emit({ type: "subagent_end", subagentId, name: task.name, result: resultText })
            return { name: task.name, text: resultText }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await emit({
              type: isBackground ? "subagent_background_fail" : "subagent_fail",
              subagentId,
              name: task.name,
              error: message,
            })
            this.updateBackgroundJob(subagentId, { status: "error", error: message, completedAt: Date.now() })
            return { name: task.name, text: "", error: message }
          } finally {
            if (!isBackground && worktreeCleanup) worktreeCleanup()
          }
        }),
      )
      output.push(...results)
    }
    return output
  }

  private async runBackgroundSubagent(
    subagentId: string,
    prompt: string,
    childConfig: TrayambakConfig,
    profile: AgentProfile | undefined,
    isolation: string,
    worktreeCleanup: (() => void) | undefined,
  ): Promise<void> {
    const emit = this.backgroundEmit ?? this.currentEmit ?? (() => undefined)
    // Display name for lifecycle events — the id was wrongly used before.
    const jobName = this.backgroundJobs.get(subagentId)?.name ?? subagentId
    const controller = new AbortController()
    this.backgroundControllers.set(subagentId, controller)
    try {
      const child = await Agent.create({
        config: childConfig,
        mode: profile?.category === "reviewer" ? "default" : "coder",
        specialistPrompt: profile?.prompt,
        subagentDepth: this.subagentDepth + 1,
        inboxId: subagentId,
        onAskUserQuestion: this.onAskUserQuestion,
        onRequestPermission: this.onRequestPermission,
        subagentRunner: this.subagentRunner,
      })
      const messages = await child.run(prompt, tagSubagentEmit(emit, subagentId, jobName), controller.signal)
      const assistant = [...messages].reverse().find((message) => message.role === "assistant")
      const text = assistant?.content.find((part) => part.type === "text")
      const resultText = text && "text" in text ? text.text : ""
      this.updateBackgroundJob(subagentId, { status: "completed", output: resultText, completedAt: Date.now() })
      await emit({ type: "subagent_background_end", subagentId, name: jobName, result: resultText })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateBackgroundJob(subagentId, { status: "error", error: message, completedAt: Date.now() })
      await emit({ type: "subagent_background_fail", subagentId, name: jobName, error: message })
    } finally {
      this.backgroundControllers.delete(subagentId)
      if (worktreeCleanup) worktreeCleanup()
    }
  }

  /** Abort a running background job. The rejection surfaces through the
   *  normal background_fail path; callers (TUI) mark it cancelled first so
   *  the abort noise doesn't overwrite the user's verdict. */
  cancelBackgroundJob(id: string): boolean {
    const controller = this.backgroundControllers.get(id)
    const job = this.backgroundJobs.get(id)
    if (!controller || !job || job.status !== "running") return false
    controller.abort()
    return true
  }

  /** Resolve a SendMessage target to a background job (by id, exact name,
   *  or unique name substring). Lets the tool answer honestly: delivered
   *  to a running job (it polls its inbox next turn) vs stored-but-unread
   *  (finished/unknown — nobody will ever read it). */
  resolveSendMessageTarget(to: string): { id: string; name: string; running: boolean } | undefined {
    for (const job of this.backgroundJobs.values()) {
      if (job.id === to || job.name === to) {
        return { id: job.id, name: job.name, running: job.status === "running" }
      }
    }
    const norm = to.trim().toLowerCase()
    if (!norm) return undefined
    const hits = Array.from(this.backgroundJobs.values()).filter((j) => j.name.toLowerCase().includes(norm))
    if (hits.length === 1) {
      const job = hits[0]
      return { id: job.id, name: job.name, running: job.status === "running" }
    }
    return undefined
  }

  private updateBackgroundJob(id: string, update: Partial<BackgroundSubagentInfo>): void {
    const existing = this.backgroundJobs.get(id)
    if (!existing) return
    const updated: BackgroundSubagentInfo = { ...existing, ...update }
    this.backgroundJobs.set(id, updated)
    // Cap: finished jobs otherwise accumulate for the process lifetime.
    // Running jobs are never dropped.
    if (this.backgroundJobs.size > 50) {
      const finished = Array.from(this.backgroundJobs.values())
        .filter((j) => j.status !== "running")
        .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt))
      const excess = this.backgroundJobs.size - 50
      for (let i = 0; i < excess && i < finished.length; i += 1) {
        this.backgroundJobs.delete(finished[i]!.id)
      }
    }
  }

  listBackgroundJobs(): BackgroundSubagentInfo[] {
    return Array.from(this.backgroundJobs.values())
  }

  getBackgroundJob(id: string): BackgroundSubagentInfo | undefined {
    return this.backgroundJobs.get(id)
  }

  promoteBackgroundJob(id: string): boolean {
    const job = this.backgroundJobs.get(id)
    if (!job || job.status !== "running") return false
    return true
  }

  setBackgroundEmit(emit: AgentEventSink): void {
    this.backgroundEmit = emit
  }

  async runSubagentRequest(params: {
    description: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
    background?: boolean
  }): Promise<string> {
    if (this.subagentRunner) {
      const result = await this.subagentRunner(
        {
          name: params.description,
          prompt: params.prompt,
          subagentType: params.subagentType,
          model: params.model,
          isolation: params.isolation,
          background: params.background,
        },
        () => undefined,
      )
      if (result.error) throw new Error(result.error)
      return result.text || "Subagent completed without text output."
    }
    const results = await this.runSubagents(
      [
        {
          name: params.description,
          prompt: params.prompt,
          subagentType: params.subagentType,
          model: params.model,
          isolation: params.isolation,
          background: params.background,
        },
      ],
      this.currentEmit,
    )
    const result = results[0]
    if (!result) return "Subagent returned no result."
    if (result.error) throw new Error(result.error)
    if (result.background)
      return `Subagent '${result.name}' started in background (id: ${result.subagentId ?? "unknown"}). You will be notified when it completes.`
    return result.text || "Subagent completed without text output."
  }

  save(): void {
    if (this.sessionFile) this.session.save(this.sessionFile)
  }
}

export function modeSystemPromptSuffix(mode: string): string {
  const suffixes: Record<string, string> = {
    default: "",
    coder:
      "Current mode: coder. Prioritize code edits, refactors, and implementation. Keep changes minimal and run lint/tests after edits.",
    browser:
      "Current mode: browser. Use web search and web fetch aggressively. Prefer live sources over training-cutoff knowledge. Cite URLs when possible.",
    planner:
      "Current mode: planner. Favor planning, research, and step-by-step breakdowns before editing. Ask clarifying questions when requirements are ambiguous.",
    sota: "Current mode: sota (SOTA inference-time reasoning). Use tree-based search across multiple approaches, execute candidates in the sandbox, verify independently, and backtrack/re-solve on failures. Use sota_solve for code tasks. Only the best verified branch is delivered.",
    cot: "Current mode: cot (chain-of-thought). Run the CoT-4 parallel pipeline: generate 4 candidate solutions, sandbox-execute each, grade with tests, apply reward/penalty, and pick the best. Record outcomes to skt/5-eval/COT-REPORT.md.",
  }
  const text = suffixes[mode] ?? ""
  return text ? `\n${text}` : ""
}

/**
 * Safely create a temporary git worktree for subagent isolation.
 * Returns the new cwd and a cleanup function that removes the worktree.
 * Falls back to the original cwd when the repo is not a git repo or git fails.
 */
export async function createWorktreeIsolation(repoRoot: string): Promise<{ cwd: string; cleanup: () => void }> {
  const fallback = { cwd: repoRoot, cleanup: () => undefined }
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot })
  } catch {
    return fallback
  }
  const wtRoot = path.join(repoRoot, ".trayambak", "worktrees")
  fs.mkdirSync(wtRoot, { recursive: true })
  const name = `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const wtPath = path.join(wtRoot, name)
  try {
    await exec("git", ["worktree", "add", "--detach", wtPath], { cwd: repoRoot })
  } catch {
    return fallback
  }
  const cleanup = (): void => {
    try {
      execFile("git", ["worktree", "remove", "--force", wtPath], { cwd: repoRoot }, () => undefined)
    } catch {
      /* best-effort cleanup */
    }
    try {
      if (fs.existsSync(wtPath)) {
        fs.rmSync(wtPath, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
  }
  return { cwd: wtPath, cleanup }
}

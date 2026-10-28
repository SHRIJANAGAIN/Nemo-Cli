/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { AgentEventSink, AgentMessage, AssistantMessage } from "../../../../packages/protocol/src/index.js"
import {
  createLlamaCppProvider,
  createNvidiaProvider,
  createCustomProvider,
  createOllamaProvider,
  clampTemperature,
  type Provider,
  type ProviderOptions,
  type WireMessage,
} from "../../../../packages/provider/src/index.js"
import type { NemoConfig } from "../config.js"
import { buildSystemPrompt, buildOperatorBlock } from "../prompt/power-prompt.js"
import { getMachineId } from "../license.js"
import { Session } from "../session/session.js"
import { createDefaultTools, buildOptionalTools, toolDefinitions, getContextBlock, type Tool } from "../tools/index.js"
import { getNemoContextBlock } from "../../../../nemo/context.js"
import { getRulesContextBlock } from "../prompt/rules.js"
import { DeveloperModeEngine, DEFAULT_DEVELOPER_MODE_CONFIG, isLocalProvider } from "../developer-mode/index.js"
import { SotaDevMode } from "../developer-mode/sota-mode.js"
import { runAgentLoop } from "./agent-loop.js"
import { guardPrompt } from "./prompt-guard.js"
import type { GoalStore } from "../goals.js"
import type { SelfImprovementStore } from "../self-improvement.js"
import { HarnessRuntime, type HarnessPlugin } from "../../../../packages/harness/src/index.js"
import { composeHarnessBlock } from "./improved-harness.js"
import { discoverAgentProfiles, getAgentProfile, type AgentProfile } from "./specialist-agents.js"
import { companyAgentDirs, buildCompanyBlock, companyModelForProfile, resolveCompanyState } from "./company-library.js"
import { DEFAULT_PERMISSIONS } from "../../../../packages/protocol/src/permissions.js"
import { Arsenal } from "../../../../packages/core/src/toolsets/arsenal.js"
import { getDatabase } from "../../../../packages/core/src/state_db.js"
import { createReadFileTool } from "../tools/file-edit/read-file.js"
import { gitExec } from "../git_exec.js"
import {
  createSubagentTask,
  SubagentEngine,
  SubagentWorkerError,
  type BackgroundSubagentStatus,
  type SubagentTask,
  type WorkerContext,
  type WorkerResult,
  type WorkerUsage,
} from "../../../../packages/core/src/subagents.js"
import { recordModelUsage } from "./usage-accounting.js"

/**
 * Tools that spawn MORE agents. Withheld from subagent children so fan-out
 * is bounded by the depth guard alone (SubagentEngine) instead of growing
 * unbounded through nested Agent/Team calls.
 */
const SUBAGENT_FANOUT_TOOLS = new Set([
  "nemo__Agent",
  "nemo__RunTeam",
  "nemo__Swarm",
  "nemo__ParallelReview",
  "nemo__ParallelExecute",
])

/**
 * Wrap an event sink so every event emitted by a child (subagent) loop is
 * tagged with the subagent that produced it. UIs use the tag to route nested
 * tool/streaming activity to the subagent's card instead of the parent
 * transcript (Shrijan renders nested parts under the task card; Ink flattens).
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

/** Map an engine background status to the public BackgroundSubagentInfo view. */
function backgroundStatusToInfo(status: BackgroundSubagentStatus): BackgroundSubagentInfo {
  return {
    id: status.id,
    name: status.task.description,
    prompt: status.task.prompt,
    subagentType: status.task.type,
    model: status.task.model,
    isolation: status.task.isolation,
    status: status.status,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    output: status.output,
    error: status.error,
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
  config: NemoConfig
  /** Provider to reuse as-is. Subagent children share the parent's instance
   *  (fresh Session, same provider/config/emit) unless a model override
   *  requests a different one. Tests inject mock providers here. */
  provider?: Provider | undefined
  tools?: Tool[]
  sessionFile?: string
  sessionId?: string
  /** Durable-inbox id this agent's loop polls each turn (SendMessage delivery). */
  inboxId?: string
  developerMode?: Partial<typeof DEFAULT_DEVELOPER_MODE_CONFIG>
  mode?: string
  specialistPrompt?: string
  plugins?: HarnessPlugin[]
  /**
   * The harness block: the system prompt, guardrails, tool guidance,
   * memory, skills index, subagents index and scripts listing that shape
   * this agent's behaviour. Rendered into the system prompt ahead of the
   * optional blocks, so the harness frames the task instead of competing
   * with it. Set by the recursive harness when it probes a candidate.
   */
  harnessBlock?: string
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

/**
 * Durable-audit handle for the agent loop's tool gate. Resolves the state
 * store lazily and degrades to "no audit" (never throws): a broken audit
 * store must not take down an agent run — the gate treats audit as
 * evidence, not control flow.
 */
function auditSink(): { recordAudit(action: string, actor: string, target: string, result: string): void } | undefined {
  try {
    return getDatabase()
  } catch {
    return undefined
  }
}

export class Agent {
  readonly config: NemoConfig
  provider: Provider
  /**
   * Options the config-built provider was created from, kept so a
   * backend supervisor decision can rebuild it with a new temperature.
   * Undefined when `options.provider` was injected (tests / TUI) — the
   * agent must never swap an injected provider out.
   */
  private providerOptions?: ProviderOptions
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
  private backgroundEmit?: AgentEventSink
  /** Durable-inbox id polled by this agent's loop (see RunConfig.inboxId). */
  private readonly inboxId?: string
  /** Subagent orchestration engine: depth guard, isolated workers, usage
   *  summaries, subagent_* lifecycle events, and the background registry
   *  (start / getStatus / await / cancel via AbortController). */
  private readonly subagentEngine: SubagentEngine

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
    this.subagentEngine = new SubagentEngine({
      runWorker: (task, ctx) => this.runSubagentWorker(task, ctx),
    })
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
            {
              onListFleet: () => this.listBackgroundJobs(),
              onGetMode: () => this.mode,
              onSetMode: (mode) => this.setMode(mode),
              onGetProvider: () => this.provider,
            },
          )
    this.tools = tools
    if (arsenal) {
      this.arsenal = arsenal
    }
    this.developerMode = new DeveloperModeEngine(this.config.cwd, devConfig)
    // Provider-aware: mistake penalties tune local samplers only (ollama /
    // llama.cpp) — hosted backends get the clean control-mode base. Same
    // default as provider selection below (unknown → google).
    const devOverrides = this.developerMode.getConfigOverrides({ provider: this.config.provider ?? "nvidia" })
    // Clamped like config sanitize ([0, 2]): an unbounded dev override used
    // to reach the wire verbatim (observed live: 2.7 → NVIDIA HTTP 400).
    // Per-backend ceilings bind later, at each provider's body builder.
    const temperature =
      devOverrides.temperature !== undefined
        ? clampTemperature(Number(devOverrides.temperature), this.config.temperature, 2)
        : this.config.temperature
    const topP = (devOverrides.topP !== undefined ? Number(devOverrides.topP) : this.config.topP) as number
    const maxTokens = (
      devOverrides.maxTokens !== undefined ? Number(devOverrides.maxTokens) : this.config.maxTokens
    ) as number
    const providerOptions: ProviderOptions = {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      temperature,
      topP,
      maxTokens,
      timeoutMs: this.config.timeoutMs,
      reasoningEffort: this.config.reasoningEffort,
    }
    if (!options.provider) {
      this.providerOptions = providerOptions
    }
    this.provider = options.provider ?? this.createProviderForConfig(providerOptions)
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
        operatorBlock: this.operatorBlock(),
        companyBlock: buildCompanyBlock(this.config.cwd, this.config) || undefined,
        developerModeSuffix: this.developerMode.getSystemPromptSuffix(),
        modeSuffix: specialistBlock + modeSystemPromptSuffix(this.mode),
        nemoBlock: getNemoContextBlock(),
        rulesBlock: getRulesContextBlock(this.config.cwd),
        harnessBlock: options.harnessBlock,
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

  /**
   * Build the provider for the configured id.
   *
   * Nemo talks to exactly one cloud backend — NVIDIA (and its NIM alias) —
   * plus the two local runtimes and a user-supplied OpenAI-shaped endpoint.
   * An unknown id refuses loudly rather than falling back to another
   * provider's endpoint: a silent fallback sends the request somewhere the
   * user did not ask for, which reads as "that provider is down".
   */
  private createProviderForConfig(options: ProviderOptions): Provider {
    const provider = this.config.provider ?? "nvidia"
    const useOption = (value: string | undefined, fallback: string): string =>
      value !== undefined && value.length > 0 ? value : fallback

    if (provider === "nvidia" || provider === "nvidia-nim") {
      return createNvidiaProvider({
        ...options,
        baseUrl: useOption(options.baseUrl, "https://integrate.api.nvidia.com"),
        model: useOption(options.model, "nvidia/nemotron-3-super-120b-a12b"),
      })
    }
    if (provider === "ollama") {
      return createOllamaProvider({
        ...options,
        baseUrl: useOption(options.baseUrl, "http://localhost:11434"),
        model: useOption(options.model, "llama3.1"),
      })
    }
    if (provider === "custom") {
      return createCustomProvider({
        ...options,
        baseUrl: useOption(options.baseUrl, "http://localhost:8080"),
        model: options.model ?? "",
      })
    }
    if (provider === "llamacpp") {
      return createLlamaCppProvider(options)
    }

    throw new Error(
      `Unknown provider "${provider}". Pick one of: llamacpp, nvidia, nvidia-nim, ollama, custom.`,
    )
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
          const wire: WireMessage[] = [{ role: "system", content: system }, ...(messages as WireMessage[])]
          const response = await this.provider.chat({ messages: wire })
          const textPart = response.content.find((c) => c.type === "text")
          const text = textPart ? String(textPart.text) : ""
          // SOTA answers complex prompts INSTEAD of runAgentLoop, so the loop's
          // usage recording never sees it — and one solve is not one call: the
          // engines invoke `generate` per candidate, per re-solve, per verify
          // step and per CoT-chain node. Uncharged, a token cap ignored the
          // single most expensive path in the agent.
          recordModelUsage(JSON.stringify(wire), text)
          return text
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

  /** Operator identity for the system prompt (GitHub login, license
   *  presence, machine prefix). Best-effort: identity must never break
   *  construction — unknown fields simply read absent. */
  private operatorBlock(): string {
    let machineShortId: string | undefined
    try {
      machineShortId = getMachineId().slice(0, 8)
    } catch {
      machineShortId = undefined
    }
    return buildOperatorBlock({
      githubLogin: this.config.githubLogin,
      hasLicense: (this.config.licenseKey?.length ?? 0) > 0,
      machineShortId,
    })
  }

  /** Rebuild the system prompt.
   *
   *  `memoryQuery` re-ranks the long-term memories by relevance to the text
   *  that is being resumed, so a resumed conversation opens with what it is
   *  actually about. Without it the newest memories are used. */
  refreshSystemPrompt(memoryQuery?: string): void {
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
        memoryBlock: getContextBlock(8, memoryQuery),
        operatorBlock: this.operatorBlock(),
        developerModeSuffix: this.developerMode.getSystemPromptSuffix(),
        modeSuffix: specialistBlock + modeSystemPromptSuffix(this.mode) + (this.goalStore?.context() ?? ""),
        selfImprovementBlock: this.selfImprovement?.context(),
        harnessBlock: composeHarnessBlock(this.harness.context()),
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

    // Pre-model prompt guard (agent/prompt-guard.ts): extraction and
    // credential-value prompts must reach ZERO provider calls on every path.
    // The SOTA branch below calls a model WITHOUT going through runAgentLoop,
    // so it is gated on the same verdict; runAgentLoop re-runs the guard on
    // entry (idempotent on an already-neutralized prompt) as the canonical
    // refusal path, so a refused prompt still exits with the standard
    // refusal message even when SOTA is enabled.
    const promptVerdict = guardPrompt(prompt)
    const isComplex =
      prompt.length > 100 || /\b(code|function|implement|debug|fix|build|create|design|plan|analyze)\b/i.test(prompt)
    if (this.sotaMode?.isEnabled() && isComplex && promptVerdict.action === "allow") {
      this.sotaMode.setSignal(signal)
      const userMessage: AgentMessage = { role: "user", content: promptVerdict.prompt }
      this.session.add(userMessage)
      try {
        const result = await this.sotaMode.runSotaReasoning(promptVerdict.prompt)
        const assistant: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: result.solution }],
          stopReason: "end_turn",
        }
        this.session.add(assistant)
        await emit({ type: "message_start", message: assistant })
        await emit({ type: "message_end", message: assistant })
        await emit({ type: "agent_end", messages: this.session.messages })
        this.selfImprovement?.observe(prompt, result.solution, /*hadError*/ false)
        this.selfImprovement?.refine()
        await this.harness.emit({ type: "turn_end", prompt, success: true })
        this.refreshSystemPrompt()
        return [assistant]
      } catch (error) {
        this.selfImprovement?.observe(prompt, error instanceof Error ? error.message : String(error), /*hadError*/ true)
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

    // Backend decision LLM: when the PRIMARY model is a weak local sampler
    // (ollama / llama.cpp) and a supervisor is configured, let that backend
    // model re-choose the penalty knobs from the mistake log before the
    // turn runs. Gated to local providers only (hosted APIs never pay this
    // call), and fail-open inside — unconfigured / no new mistakes / any
    // error keeps the heuristic penalties.
    const activeProviderId = this.config.provider ?? "nvidia"
    if (this.developerMode.isEnabled() && isLocalProvider(activeProviderId)) {
      const decision = await this.developerMode.runSupervisorDecision({ signal })
      const baseOptions = this.providerOptions
      if (decision?.temperature !== undefined && baseOptions) {
        // Temperature is baked into the provider at construction — rebuild
        // it so the backend's decision actually reaches the wire. Injected
        // providers (providerOptions undefined) are never swapped.
        this.providerOptions = { ...baseOptions, temperature: decision.temperature }
        this.provider = this.createProviderForConfig(this.providerOptions)
      }
    }

    let messages: AgentMessage[]
    try {
      const runTools = this.arsenal ? this.arsenal.resolveTools(this.tools) : this.tools
      // Same provider-aware penalties as construction above (maxToolCalls
      // caps from foreign-backend mistake logs must not leak in either).
      const devOverrides = this.developerMode.getConfigOverrides({ provider: this.config.provider ?? "nvidia" })
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
        audit: auditSink(),
        maxToolCalls:
          devOverrides.maxToolCalls !== undefined ? Number(devOverrides.maxToolCalls) : this.config.maxToolCalls,
        maxParallelToolCalls: this.config.maxParallelToolCalls,
        sessionId: this.sessionId,
      })
    } catch (error) {
      this.selfImprovement?.observe(prompt, error instanceof Error ? error.message : String(error), /*hadError*/ true)
      this.selfImprovement?.refine()
      this.refreshSystemPrompt()
      await this.harness.emit({ type: "error", prompt, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const response = [...messages].reverse().find((message) => message.role === "assistant")
    const text = response?.content.find((part) => part.type === "text")
    this.selfImprovement?.observe(prompt, text && "text" in text ? text.text : "", /*hadError*/ false)
    this.selfImprovement?.refine()
    await this.harness.emit({ type: "turn_end", prompt, success: true })
    this.refreshSystemPrompt()
    return messages
  }

  /** agentProfileDirs plus the configured company library's ENABLED
   *  divisions (discovery ALSO auto-includes env/home defaults — the
   *  explicit config root only needs merging here when it points
   *  somewhere custom; the state gate keeps master-OFF/disabled
   *  departments out of subagent runs). */
  private profileDirsWithCompany(): string[] | undefined {
    const base = this.config.agentProfileDirs
    const state = resolveCompanyState(this.config.companyDir, this.config.cwd, undefined, this.config)
    if (!state?.enabled) return base
    const extra = companyAgentDirs(state.root, state.disabled)
    if (extra.length === 0) return base
    return [...(base ?? []), ...extra]
  }

  discoverAgentProfiles(): AgentProfile[] {
    return discoverAgentProfiles(this.config.cwd, this.profileDirsWithCompany())
  }

  async runSubagents(
    tasks: Array<SubagentRunTask | { name: string; prompt: string }>,
    emit?: AgentEventSink,
  ): Promise<SubagentResult[]> {
    // Foreground children stream into the spawning run's sink; background
    // children complete later, so they prefer the dedicated background sink.
    const foregroundEmit = emit ?? this.currentEmit
    const backgroundEmit = this.backgroundEmit ?? foregroundEmit
    const limit = Math.max(1, Math.min(this.config.maxParallelToolCalls, this.developerMode.config.maxSubagents))
    const output: SubagentResult[] = []
    for (let i = 0; i < tasks.length; i += limit) {
      const batch = tasks.slice(i, i + limit)
      const results = await Promise.all(
        batch.map(async (task): Promise<SubagentResult> => {
          const runTask = task as SubagentRunTask
          const subagentTask = createSubagentTask({
            description: runTask.name,
            prompt: runTask.prompt,
            type: runTask.subagentType ?? "general",
            model: runTask.model,
            isolation: runTask.isolation,
            background: runTask.background,
          })
          if (runTask.background === true) {
            const outcome = this.subagentEngine.startBackground(subagentTask, {
              depth: this.subagentDepth,
              emit: backgroundEmit,
            })
            if (!outcome.ok) return { name: runTask.name, text: "", error: outcome.error?.message }
            return { name: runTask.name, text: "", background: true, subagentId: outcome.id }
          }
          // Depth guard, subagent_start/end events, and usage accounting all
          // live in the core engine — one code path for every spawn.
          const outcome = await this.subagentEngine.run(subagentTask, {
            depth: this.subagentDepth,
            emit: foregroundEmit,
            signal: this.currentSignal,
          })
          if (!outcome.ok) return { name: runTask.name, text: "", error: outcome.error?.message }
          return { name: runTask.name, text: outcome.text }
        }),
      )
      output.push(...results)
    }
    return output
  }

  /**
   * Usage for one child run, derived from the messages it produced.
   *
   * Used on both the success and the failure path, so a run that dies partway
   * still reports the turns and tool calls it actually spent. `durationMs` is
   * clamped at zero because a non-monotonic clock adjustment would otherwise
   * sum a negative duration into the aggregate.
   */
  private usageFromMessages(messages: readonly AgentMessage[], startedAt: number): WorkerUsage {
    let turns = 0
    let toolCalls = 0
    for (const message of messages) {
      if (message.role !== "assistant") continue
      turns++
      toolCalls += message.content.filter((part) => part.type === "toolCall").length
    }
    return { turns, toolCalls, durationMs: Math.max(0, Date.now() - startedAt) }
  }

  /**
   * Engine worker: one isolated subagent run. A fresh child Agent owns a
   * fresh Session; the parent's provider, config, and event sink are reused
   * (unless a model override requests a different provider); tools are this
   * agent's resolved set minus the fan-out tools. Returns the worker's final
   * text plus its usage summary (turns / tool calls / duration) for the
   * engine's per-task and aggregate usage summaries.
   */
  private async runSubagentWorker(task: SubagentTask, ctx: WorkerContext): Promise<WorkerResult> {
    const startedAt = Date.now()
    const profile = getAgentProfile(task.type, this.config.cwd, this.profileDirsWithCompany())
    const isolation = task.isolation ?? "inherit"
    const explicitModel = task.model && task.model !== "" && task.model !== this.config.model ? task.model : undefined
    // Legacy parity (subagent_model): an explicit per-task model wins; else the
    // configured cheap default applies when it differs from this run's model;
    // otherwise the child shares the parent's provider instance (no rebuild).
    const configuredModel =
      this.config.subagent_model &&
      this.config.subagent_model !== "" &&
      this.config.subagent_model !== this.config.model
        ? this.config.subagent_model
        : undefined
    // Company personas run on `companyModel` when set (and different from
    // the session model); unset = one model does everything. Explicit
    // per-task models always win over the company default.
    const companyModel = companyModelForProfile(profile?.source, this.config, this.config.model)
    const modelOverride = explicitModel ?? companyModel ?? configuredModel
    const baseChildConfig: NemoConfig = {
      ...this.config,
      permissions: { ...(this.config.permissions ?? DEFAULT_PERMISSIONS), askByDefault: false },
    }
    let childConfig: NemoConfig = modelOverride ? { ...baseChildConfig, model: modelOverride } : baseChildConfig
    let worktreeCleanup: (() => void) | undefined
    let child: Agent | undefined
    try {
      if (isolation === "worktree") {
        const wt = await createWorktreeIsolation(this.config.cwd)
        worktreeCleanup = wt.cleanup
        childConfig = { ...childConfig, cwd: wt.cwd }
      }
      child = new Agent({
        config: childConfig,
        // Reuse the parent's provider instance; a model override makes the
        // child build its own from (the overridden) config.
        provider: modelOverride ? undefined : this.provider,
        tools: this.subagentChildTools(),
        mode: profile?.category === "reviewer" ? "default" : "coder",
        specialistPrompt: profile?.prompt,
        subagentDepth: ctx.depth,
        inboxId: task.id,
        onAskUserQuestion: this.onAskUserQuestion,
        onRequestPermission: this.onRequestPermission,
        subagentRunner: this.subagentRunner,
      })
      const sink: AgentEventSink = ctx.emit ?? this.backgroundEmit ?? this.currentEmit ?? ((): void => undefined)
      const messages = await child.run(task.prompt, tagSubagentEmit(sink, task.id, task.description), ctx.signal)
      const assistant = [...messages].reverse().find((message) => message.role === "assistant")
      const text = assistant?.content.find((part) => part.type === "text")
      const resultText = text && "text" in text ? text.text : ""
      return { text: resultText, usage: this.usageFromMessages(messages, startedAt) }
    } catch (error) {
      // A subagent that dies after N turns still spent them, and the nested
      // loop already charged them to the rollout budget. Reporting the spend
      // keeps a failed run from reading as one that never happened.
      const spent = child ? this.usageFromMessages(child.session.messages, startedAt) : undefined
      if (spent && spent.turns + spent.toolCalls > 0) {
        throw new SubagentWorkerError(error instanceof Error ? error.message : String(error), spent)
      }
      throw error
    } finally {
      worktreeCleanup?.()
    }
  }

  /**
   * Child tool set: the same resolved tools this agent runs with, minus the
   * spawn tools (Agent/Team delegation) so nesting is bounded by the depth
   * guard alone. Falls back to a read-only floor if a pathological toolset
   * left nothing (the child constructor reverts to full defaults on empty).
   */
  private subagentChildTools(): Tool[] {
    const tools = this.tools.filter((tool) => !SUBAGENT_FANOUT_TOOLS.has(tool.definition.name))
    return tools.length > 0 ? tools : [createReadFileTool()]
  }

  /** Abort a running background job. The rejection surfaces through the
   *  normal background_fail path; callers (TUI) mark it cancelled first so
   *  the abort noise doesn't overwrite the user's verdict. */
  cancelBackgroundJob(id: string): boolean {
    return this.subagentEngine.cancelBackground(id)
  }

  /** Resolve a SendMessage target to a background job (by id, exact name,
   *  or unique name substring). Lets the tool answer honestly: delivered
   *  to a running job (it polls its inbox next turn) vs stored-but-unread
   *  (finished/unknown — nobody will ever read it). */
  resolveSendMessageTarget(to: string): { id: string; name: string; running: boolean } | undefined {
    const jobs = this.subagentEngine.listBackground()
    for (const job of jobs) {
      if (job.id === to || job.task.description === to) {
        return { id: job.id, name: job.task.description, running: job.status === "running" }
      }
    }
    const norm = to.trim().toLowerCase()
    if (!norm) return undefined
    const hits = jobs.filter((job) => job.task.description.toLowerCase().includes(norm))
    if (hits.length === 1) {
      const job = hits[0]
      return { id: job.id, name: job.task.description, running: job.status === "running" }
    }
    return undefined
  }

  listBackgroundJobs(): BackgroundSubagentInfo[] {
    return this.subagentEngine.listBackground().map(backgroundStatusToInfo)
  }

  getBackgroundJob(id: string): BackgroundSubagentInfo | undefined {
    const status = this.subagentEngine.getStatus(id)
    return status ? backgroundStatusToInfo(status) : undefined
  }

  /** Whether the background job is still running. (Previously misnamed
   *  `promoteBackgroundJob`, which promised a foreground promotion it never
   *  performed — the name now says what it does: a status check.) */
  isBackgroundJobRunning(id: string): boolean {
    return this.subagentEngine.getStatus(id)?.status === "running"
  }

  /** Aggregate usage summary across this agent's subagent runs. */
  subagentUsage(): WorkerUsage {
    return this.subagentEngine.aggregateUsage()
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
    cot: "Current mode: cot (chain-of-thought). Run the CoT-4 parallel pipeline: generate 4 candidate solutions, sandbox-execute each, grade with tests, apply reward/penalty, and pick the best. Record outcomes to nemo/5-eval/COT-REPORT.md.",
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
    await gitExec(["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot })
  } catch {
    return fallback
  }
  const wtRoot = path.join(repoRoot, ".nemo", "worktrees")
  fs.mkdirSync(wtRoot, { recursive: true })
  const name = `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const wtPath = path.join(wtRoot, name)
  try {
    await gitExec(["worktree", "add", "--detach", wtPath], { cwd: repoRoot })
  } catch {
    return fallback
  }
  const cleanup = (): void => {
    try {
      gitExec(["worktree", "remove", "--force", wtPath], { cwd: repoRoot }).catch(() => undefined)
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

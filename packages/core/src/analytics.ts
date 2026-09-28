/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Analytics — compaction events, hook run events, and rollout tracking.
 *
 * Mirrors codex-rs/codex-analytics and codex-history in Rust.
 * Provides telemetry and analytics infrastructure for the agent.
 */

/** Compaction event types. */
export enum CompactionReason {
  Auto = "auto",
  Manual = "manual",
  MaxTokens = "max_tokens",
  ContextOverflow = "context_overflow",
}

/** Compaction strategy. */
export enum CompactionStrategy {
  Default = "default",
  Aggressive = "aggressive",
  Conservative = "conservative",
}

/** Compaction phase. */
export enum CompactionPhase {
  PreCompact = "pre_compact",
  Compacting = "compacting",
  PostCompact = "post_compact",
}

/** Compaction trigger source. */
export enum CompactionTrigger {
  TurnLimit = "turn_limit",
  TokenLimit = "token_limit",
  Manual = "manual",
  ContextOverflow = "context_overflow",
}

/** Compaction status. */
export enum CompactionStatus {
  Started = "started",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

/** Compaction implementation type. */
export enum CompactionImplementation {
  Api = "api",
  Local = "local",
  Hybrid = "hybrid",
}

/** A compaction event. */
export interface CodexCompactionEvent {
  reason: CompactionReason
  strategy: CompactionStrategy
  phase: CompactionPhase
  trigger: CompactionTrigger
  status: CompactionStatus
  implementation: CompactionImplementation
  timestamp: number
  turnCount: number
  tokensBefore: number
  tokensAfter: number
  durationMs: number
  metadata?: Record<string, unknown>
}

/** Hook run fact for analytics. */
export interface HookRunFact {
  eventName: string
  durationMs: number
  status: "success" | "failed" | "timeout"
  output: string
  timestamp: number
}

/** Agent telemetry event. */
export interface AgentEvent {
  type: "turn_start" | "turn_end" | "tool_execution" | "compaction" | "hook_run" | "agent_communication"
  timestamp: number
  data: Record<string, unknown>
}

/** Rollout tracking data. */
export interface RolloutItem {
  turnId: string
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  toolCalls: number
  durationMs: number
}

/**
 * Analytics Manager — collects and reports telemetry events.
 *
 * Mirrors codex-rs/codex-analytics in Rust.
 * Tracks compaction events, hook run facts, rollout items,
 * and agent lifecycle events.
 */
export class AnalyticsManager {
  private static instance: AnalyticsManager | null = null
  private events: AgentEvent[] = []
  private compactionEvents: CodexCompactionEvent[] = []
  private hookRunFacts: HookRunFact[] = []
  private rolloutItems: RolloutItem[] = []
  private readonly maxEvents = 10_000

  private constructor() {}

  /** Get the singleton AnalyticsManager instance. */
  static getInstance(): AnalyticsManager {
    if (!AnalyticsManager.instance) {
      AnalyticsManager.instance = new AnalyticsManager()
    }
    return AnalyticsManager.instance
  }

  // --- Compaction Events ---

  /** Record a compaction event. */
  recordCompaction(event: Omit<CodexCompactionEvent, "timestamp">): void {
    const fullEvent: CodexCompactionEvent = {
      ...event,
      timestamp: Date.now(),
    }
    this.compactionEvents.push(fullEvent)
    this.events.push({
      type: "compaction",
      timestamp: fullEvent.timestamp,
      data: { ...(fullEvent as unknown as Record<string, unknown>) },
    })
    this.trimEvents()
  }

  /** Get all compaction events. */
  getCompactionEvents(): CodexCompactionEvent[] {
    return [...this.compactionEvents]
  }

  /** Get compaction statistics. */
  getCompactionStats(): {
    total: number
    completed: number
    failed: number
    averageDurationMs: number
    averageTokensSaved: number
  } {
    const completed = this.compactionEvents.filter((e) => e.status === CompactionStatus.Completed)
    const failed = this.compactionEvents.filter((e) => e.status === CompactionStatus.Failed)
    const avgDuration =
      completed.length > 0 ? completed.reduce((sum, e) => sum + e.durationMs, 0) / completed.length : 0
    const avgTokensSaved =
      completed.length > 0
        ? completed.reduce((sum, e) => sum + (e.tokensBefore - e.tokensAfter), 0) / completed.length
        : 0

    return {
      total: this.compactionEvents.length,
      completed: completed.length,
      failed: failed.length,
      averageDurationMs: Math.round(avgDuration),
      averageTokensSaved: Math.round(avgTokensSaved),
    }
  }

  // --- Hook Run Facts ---

  /** Record a hook run fact. */
  recordHookRun(fact: Omit<HookRunFact, "timestamp">): void {
    const fullFact: HookRunFact = {
      ...fact,
      timestamp: Date.now(),
    }
    this.hookRunFacts.push(fullFact)
    this.events.push({
      type: "hook_run",
      timestamp: fullFact.timestamp,
      data: { ...(fullFact as unknown as Record<string, unknown>) },
    })
    this.trimEvents()
  }

  /** Get all hook run facts. */
  getHookRunFacts(): HookRunFact[] {
    return [...this.hookRunFacts]
  }

  // --- Rollout Items ---

  /** Record a rollout item. */
  recordRollout(item: Omit<RolloutItem, "timestamp">): void {
    const fullItem: RolloutItem = {
      ...item,
      timestamp: Date.now(),
    }
    this.rolloutItems.push(fullItem)
    this.events.push({
      type: "turn_end",
      timestamp: fullItem.timestamp,
      data: { ...(fullItem as unknown as Record<string, unknown>) },
    })
    this.trimEvents()
  }

  /** Get all rollout items. */
  getRolloutItems(): RolloutItem[] {
    return [...this.rolloutItems]
  }

  /** Get rollout statistics. */
  getRolloutStats(): {
    totalTurns: number
    totalInputTokens: number
    totalOutputTokens: number
    totalToolCalls: number
    averageTurnDurationMs: number
  } {
    const total = this.rolloutItems.length
    if (total === 0) {
      return { totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0, averageTurnDurationMs: 0 }
    }

    return {
      totalTurns: total,
      totalInputTokens: this.rolloutItems.reduce((sum, i) => sum + i.inputTokens, 0),
      totalOutputTokens: this.rolloutItems.reduce((sum, i) => sum + i.outputTokens, 0),
      totalToolCalls: this.rolloutItems.reduce((sum, i) => sum + i.toolCalls, 0),
      averageTurnDurationMs: Math.round(this.rolloutItems.reduce((sum, i) => sum + i.durationMs, 0) / total),
    }
  }

  // --- Generic Events ---

  /** Record an arbitrary agent event. */
  recordEvent(type: AgentEvent["type"], data: Record<string, unknown>): void {
    this.events.push({
      type,
      timestamp: Date.now(),
      data,
    })
    this.trimEvents()
  }

  /** Get all recorded events. */
  getEvents(): AgentEvent[] {
    return [...this.events]
  }

  /** Get events filtered by type. */
  getEventsByType(type: AgentEvent["type"]): AgentEvent[] {
    return this.events.filter((e) => e.type === type)
  }

  // --- Internal ---

  /** Trim events to max capacity. */
  private trimEvents(): void {
    while (this.events.length > this.maxEvents) {
      this.events.shift()
    }
  }

  /** Clear all analytics data (useful for testing). */
  clear(): void {
    this.events = []
    this.compactionEvents = []
    this.hookRunFacts = []
    this.rolloutItems = []
  }
}

/** Get the singleton AnalyticsManager. */
export function getAnalyticsManager(): AnalyticsManager {
  return AnalyticsManager.getInstance()
}

/**
 * Record a compaction event.
 */
export function recordCompaction(
  reason: CompactionReason,
  status: CompactionStatus,
  tokensBefore: number,
  tokensAfter: number,
  durationMs: number,
): void {
  getAnalyticsManager().recordCompaction({
    reason,
    strategy: CompactionStrategy.Default,
    phase: CompactionPhase.Compacting,
    trigger: CompactionTrigger.Manual,
    status,
    implementation: CompactionImplementation.Api,
    turnCount: 0,
    tokensBefore,
    tokensAfter,
    durationMs,
  })
}

/**
 * Record a hook run fact.
 */
export function recordHookRun(eventName: string, durationMs: number, status: string, output: string): void {
  getAnalyticsManager().recordHookRun({
    eventName,
    durationMs,
    status: status as "success" | "failed" | "timeout",
    output,
  })
}

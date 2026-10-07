/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Agent Registry — multi-agent management with limits.
 *
 * Mirrors codex-rs/core/src/agent/registry.rs in Rust.
 * Manages active agents in a session, enforces limits, and
 * tracks agent metadata.
 */

import type { AgentCommunicationKind, InterAgentCommunication } from "./agent_communication.js"

const uuid = () => globalThis.crypto.randomUUID()

/**
 * Agent metadata.
 */
export interface AgentMetadata {
  agentId?: string
  agentPath?: string
  agentNickname?: string
  agentRole?: string
}

/**
 * Agent status.
 */
export enum AgentStatus {
  Active = "active",
  Idle = "idle",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

/**
 * Sub-agent source.
 */
export enum SubAgentSource {
  User = "user",
  Model = "model",
  System = "system",
}

/**
 * Active agent entry.
 */
export interface ActiveAgent {
  agentId: string
  threadId: string
  metadata: AgentMetadata
  status: AgentStatus
  createdAt: number
  pid?: number
}

/**
 * Agent Registry — manages all active agents in a session.
 *
 * Limits:
 * - Total number of sub-agents per user session
 * - Active agent tree tracking
 * - Nickname management with suffix counting
 */
export class AgentRegistry {
  private static instance: AgentRegistry | null = null

  private activeAgents: Map<string, ActiveAgent> = new Map()
  private threadPaths: Map<string, string> = new Map()
  private usedNicknames: Set<string> = new Set()
  private totalCount = 0

  /** Maximum number of agents per session (configurable). */
  private maxAgents: number = 10

  private constructor() {}

  /**
   * Get the singleton AgentRegistry instance.
   */
  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry()
    }
    return AgentRegistry.instance
  }

  /**
   * Register a new agent.
   */
  registerAgent(
    threadId: string,
    metadata: AgentMetadata,
    maxAgents?: number,
  ): { success: boolean; agentId: string; reason?: string } {
    const limit = maxAgents ?? this.maxAgents
    if (this.totalCount >= limit) {
      return { success: false, agentId: "", reason: `Maximum ${limit} agents reached` }
    }

    const agentId = uuid()
    const agent: ActiveAgent = {
      agentId,
      threadId,
      metadata,
      status: AgentStatus.Active,
      createdAt: Date.now(),
    }

    this.activeAgents.set(agentId, agent)
    this.threadPaths.set(threadId, agentId)
    this.totalCount++

    // Assign nickname
    const nickname = this.assignNickname(metadata.agentNickname ?? "Agent")
    this.usedNicknames.add(nickname)
    agent.metadata.agentNickname = nickname

    return { success: true, agentId }
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): ActiveAgent | undefined {
    return this.activeAgents.get(agentId)
  }

  /**
   * Get an agent by thread ID.
   */
  getAgentByThread(threadId: string): ActiveAgent | undefined {
    const agentId = this.threadPaths.get(threadId)
    return agentId ? this.activeAgents.get(agentId) : undefined
  }

  /**
   * Update agent status.
   */
  updateStatus(agentId: string, status: AgentStatus): void {
    const agent = this.activeAgents.get(agentId)
    if (agent) {
      agent.status = status
    }
  }

  /**
   * Remove an agent.
   */
  removeAgent(agentId: string): void {
    const agent = this.activeAgents.get(agentId)
    if (agent) {
      this.threadPaths.delete(agent.threadId)
      this.activeAgents.delete(agentId)
      if (agent.metadata.agentNickname) {
        this.usedNicknames.delete(agent.metadata.agentNickname)
      }
      this.totalCount--
    }
  }

  /**
   * Get all active agents.
   */
  getActiveAgents(): ActiveAgent[] {
    return Array.from(this.activeAgents.values()).filter((a) => a.status === AgentStatus.Active)
  }

  /**
   * Get all agents.
   */
  getAllAgents(): ActiveAgent[] {
    return Array.from(this.activeAgents.values())
  }

  /**
   * Get total agent count.
   */
  getTotalCount(): number {
    return this.totalCount
  }

  /**
   * Check if an agent exists.
   */
  hasAgent(agentId: string): boolean {
    return this.activeAgents.has(agentId)
  }

  /**
   * Kill an agent (mark as cancelled).
   */
  killAgent(agentId: string): void {
    this.updateStatus(agentId, AgentStatus.Cancelled)
  }

  /**
   * Kill all agents.
   */
  killAll(): void {
    for (const agent of this.activeAgents.values()) {
      agent.status = AgentStatus.Cancelled
    }
    this.activeAgents.clear()
    this.threadPaths.clear()
    // removeAgent() releases the nickname on single removal; killAll has to do
    // the same or every reset in a process burns one ("Agent the 2nd", ...).
    this.usedNicknames.clear()
    this.totalCount = 0
  }

  /**
   * Set maximum agents per session.
   */
  setMaxAgents(max: number): void {
    this.maxAgents = max
  }

  /**
   * Assign a nickname with suffix counting (e.g., "Agent the 2nd").
   */
  private assignNickname(baseName: string): string {
    if (!this.usedNicknames.has(baseName)) {
      return baseName
    }
    // Count existing nicknames with this base
    let count = 0
    for (const name of this.usedNicknames) {
      if (name.startsWith(baseName)) count++
    }
    const suffix = this.ordinalSuffix(count + 1)
    return `${baseName} the ${count + 1}${suffix}`
  }

  /**
   * Get ordinal suffix (st, nd, rd, th).
   */
  private ordinalSuffix(n: number): string {
    if (n % 100 >= 11 && n % 100 <= 13) return "th"
    switch (n % 10) {
      case 1:
        return "st"
      case 2:
        return "nd"
      case 3:
        return "rd"
      default:
        return "th"
    }
  }

  /**
   * Create an inter-agent communication event.
   */
  createCommunication(
    kind: AgentCommunicationKind,
    senderThreadId: string,
    receiverThreadId: string,
    content: string,
  ): InterAgentCommunication {
    return {
      kind,
      senderThreadId,
      receiverThreadId,
      encryptedContent: content,
      timestamp: Date.now(),
      id: uuid(),
    }
  }
}

/**
 * Get the singleton AgentRegistry.
 */
export function getAgentRegistry(): AgentRegistry {
  return AgentRegistry.getInstance()
}

/**
 * Register a sub-agent for a session.
 */
export function spawnSubAgent(
  threadId: string,
  role?: string,
  maxAgents?: number,
): { agentId: string; success: boolean } {
  const registry = getAgentRegistry()
  const result = registry.registerAgent(threadId, { agentRole: role }, maxAgents)
  return { agentId: result.agentId, success: result.success }
}

/**
 * Reset the agent registry (useful for testing).
 */
export function resetAgentRegistry(): void {
  AgentRegistry.getInstance().killAll()
}

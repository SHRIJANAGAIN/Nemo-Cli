/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Agent Communication — inter-agent messaging system.
 *
 * Mirrors codex-rs/core/src/agent_communication.rs in Rust.
 * Provides spawn, message, followup, result communication
 * between agents in a session tree.
 */
import { getAnalyticsManager } from "./analytics.js"

const uuid = () => crypto.randomUUID()

/** Communication kinds — mirrors AgentCommunicationKind in Rust. */
export enum AgentCommunicationKind {
  Spawn = "spawn",
  Message = "message",
  Followup = "followup",
  Result = "result",
}

/** Communication event from one agent to another. */
export interface InterAgentCommunication {
  kind: AgentCommunicationKind
  senderThreadId: string
  receiverThreadId: string
  encryptedContent: string
  timestamp: number
  id: string
}

/** Outcome of a communication attempt. */
export interface AgentCommunicationOutcome {
  success: boolean
  communicationId: string
  error?: string
}

/**
 * Agent Communication Manager — routes messages between agents.
 *
 * Mirrors codex-rs/core/src/agent_communication.rs.
 * Manages the full lifecycle of inter-agent communication:
 * spawn notification, direct messaging, followup, and results.
 */
export class AgentCommunicationManager {
  private static instance: AgentCommunicationManager | null = null
  private communications: Map<string, InterAgentCommunication> = new Map()
  private channelHistory: Map<string, InterAgentCommunication[]> = new Map()

  private constructor() {}

  /** Get the singleton instance. */
  static getInstance(): AgentCommunicationManager {
    if (!AgentCommunicationManager.instance) {
      AgentCommunicationManager.instance = new AgentCommunicationManager()
    }
    return AgentCommunicationManager.instance
  }

  /**
   * Send a communication from one agent to another.
   */
  async send(
    kind: AgentCommunicationKind,
    senderThreadId: string,
    receiverThreadId: string,
    content: string,
  ): Promise<AgentCommunicationOutcome> {
    const communication: InterAgentCommunication = {
      kind,
      senderThreadId,
      receiverThreadId,
      encryptedContent: content,
      timestamp: Date.now(),
      id: uuid(),
    }

    this.communications.set(communication.id, communication)

    // Add to channel history
    const channel = this.getChannel(senderThreadId, receiverThreadId)
    channel.push(communication)

    // Emit telemetry
    this.emitTelemetry(communication)

    return { success: true, communicationId: communication.id }
  }

  /**
   * Get communication history between two agents.
   */
  getHistory(senderThreadId: string, receiverThreadId: string): InterAgentCommunication[] {
    return this.getChannel(senderThreadId, receiverThreadId)
  }

  /**
   * Get all communications for a specific agent.
   */
  getCommunicationsForAgent(threadId: string): InterAgentCommunication[] {
    const all: InterAgentCommunication[] = []
    for (const comm of this.communications.values()) {
      if (comm.senderThreadId === threadId || comm.receiverThreadId === threadId) {
        all.push(comm)
      }
    }
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Emit telemetry for a communication event.
   */
  private emitTelemetry(communication: InterAgentCommunication): void {
    // Mirrors the emit_agent_communication_send in Rust
    const kindStr = communication.kind as string

    // Telemetry event structure (mirrors Rust's tracing::info!)
    const event = {
      name: "codex.agent_communication",
      communication_id: communication.id,
      kind: kindStr,
      state: "send",
      sender_thread_id: communication.senderThreadId,
      receiver_thread_id: communication.receiverThreadId,
    }

    // Route through the analytics manager: the event is stored for later
    // retrieval (getEventsByType) instead of being printed from core.
    getAnalyticsManager().recordEvent("agent_communication", event)
  }

  /**
   * Get or create a communication channel between two agents.
   */
  private getChannel(senderId: string, receiverId: string): InterAgentCommunication[] {
    const key = `${senderId}->${receiverId}`
    if (!this.channelHistory.has(key)) {
      this.channelHistory.set(key, [])
    }
    return this.channelHistory.get(key)!
  }

  /**
   * Spawn a sub-agent notification.
   */
  async notifySpawn(senderThreadId: string, subagentId: string): Promise<string> {
    const result = await this.send(
      AgentCommunicationKind.Spawn,
      senderThreadId,
      subagentId,
      JSON.stringify({ type: "subagent_spawned", subagentId }),
    )
    return result.communicationId
  }

  /**
   * Send a result back from a sub-agent.
   */
  async sendResult(agentId: string, result: string): Promise<string> {
    const outcome = await this.send(AgentCommunicationKind.Result, agentId, "main", result)
    return outcome.communicationId
  }

  /**
   * Get all active communication channels.
   */
  getActiveChannels(): string[] {
    return Array.from(this.channelHistory.keys())
  }

  /**
   * Clear all communications (useful for testing).
   */
  clear(): void {
    this.communications.clear()
    this.channelHistory.clear()
  }
}

/** Get the singleton AgentCommunicationManager. */
export function getAgentCommunicationManager(): AgentCommunicationManager {
  return AgentCommunicationManager.getInstance()
}

/**
 * Send a message between two agents.
 */
export async function sendAgentMessage(senderId: string, receiverId: string, content: string): Promise<string> {
  const manager = getAgentCommunicationManager()
  const result = await manager.send(AgentCommunicationKind.Message, senderId, receiverId, content)
  return result.communicationId
}

/**
 * Notify that a sub-agent was spawned.
 */
export async function notifySubagentSpawned(senderId: string, subagentId: string): Promise<string> {
  const manager = getAgentCommunicationManager()
  return manager.notifySpawn(senderId, subagentId)
}

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Resume plumbing for the two ways a conversation comes back: the in-app
 * session picker (`onSessionResumed`) and `nemo resume <id>` (which boots the
 * TUI with a transcript file). Both have to hand the history to the AGENT, not
 * only to the screen, and both have to refresh the system prompt so the
 * long-term memory block is the current one.
 */
import { useEffect, useRef } from "react"

import type { Agent as AgentType } from "../../../../apps/runtime/src/agent/agent.js"
import { loadMemory } from "../../../../apps/runtime/src/tools/memory/memory.js"
import { Session } from "../../../../apps/runtime/src/session/session.js"
import { agentMessagesToRows, convertToAgentMessages, resumeQuery } from "./app-bootstrap.js"
import type { NemoMessage } from "./types.js"

/** Rows the agent may be seeded from: everything the model said or was told. */
function agentHistory(restored: NemoMessage[]): NemoMessage[] {
  return restored.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
}

/** Replace the agent's session with a resumed transcript and rebuild its
 *  prompt. The memory block is frozen at construction, so without the refresh
 *  a resumed chat runs on whatever memories the launch happened to inject. */
export function seedAgentWith(agent: AgentType, restored: NemoMessage[]): void {
  const history = agentHistory(restored)
  agent.session.clear()
  agent.session.messages.push(...convertToAgentMessages(history))
  agent.refreshSystemPrompt(resumeQuery(history))
}

export type BootResume =
  | { readonly ok: true; readonly rows: NemoMessage[]; readonly memories: number }
  | { readonly ok: false; readonly reason: "unreadable" }

/** Read the transcript `nemo resume <id>` pointed us at, as live-shaped rows.
 *  Pure and separate from the hook so the failure is testable and reported. */
export function bootResume(file: string): BootResume {
  const stored = Session.load(file)
  if (!stored || stored.messages.length === 0) return { ok: false, reason: "unreadable" }
  return { ok: true, rows: agentMessagesToRows(stored.messages), memories: loadMemory().length }
}

export interface ResumeState {
  agentRef: { current: AgentType | null }
  setMessages: (rows: NemoMessage[]) => void
  setStaticEpoch: (update: (epoch: number) => number) => void
  addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
}

/** Resume handling for the TUI. `nemo resume` restores BEFORE the first turn,
 *  when no agent exists yet, so the rows wait in a ref until ensureAgent builds
 *  one. */
export function useResume(state: ResumeState, initialSessionFile?: string) {
  const agentRef = state.agentRef
  const pendingSeedRef = useRef<NemoMessage[] | null>(null)

  const resumeAgentWith = (restored: NemoMessage[]): void => {
    const history = agentHistory(restored)
    if (history.length === 0) return
    if (!agentRef.current) {
      pendingSeedRef.current = history
      return
    }
    seedAgentWith(agentRef.current, history)
  }

  /** Plant the waiting transcript — called by ensureAgent right after the
   *  agent is built. */
  const applyPendingSeed = (): void => {
    const restored = pendingSeedRef.current
    if (!restored) return
    pendingSeedRef.current = null
    if (agentRef.current) seedAgentWith(agentRef.current, restored)
  }

  useEffect(() => {
    if (!initialSessionFile) return
    const result = bootResume(initialSessionFile)
    if (!result.ok) {
      state.addSystemMessage(
        `Could not read the transcript at ${initialSessionFile} — starting a new conversation instead.`,
        { persist: false },
      )
      return
    }
    if (result.rows.length > 0) {
      state.setMessages(result.rows)
      state.setStaticEpoch((e) => e + 1)
      resumeAgentWith(result.rows)
    }
    const { rows, memories } = result
    state.addSystemMessage(
      `Resumed ${rows.length} earlier message(s) — ${memories} long-term memor${memories === 1 ? "y" : "ies"} in context.`,
      { persist: false },
    )
  }, [initialSessionFile])

  return { resumeAgentWith, applyPendingSeed }
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Dialect-neutral vocabulary and types for Trayambak command hooks.
 * Adapted from the deepseek-harness hook-protocol package.
 * @module skt/14-hooks/types
 */

import type { SessionId } from "../9-session/session.js"

/**
 * The bridge that ran a hook — Trayambak native or SKT AI LABS integrated.
 * A native plugin at the interception points is not a bridge
 * and writes no `hook/*` invocation/result records.
 */
export type HookDialect = "trayambak"

/**
 * One configured command hook (the `{ type: 'command', command, timeout? }`
 * shape shared by all dialects). Non-command hook types are parsed-and-skipped, so
 * only this shape reaches the runner.
 */
export interface CommandHook {
  /** The shell command line to run. */
  command: string
  /** Per-hook timeout in SECONDS (the wire unit); the runner converts to ms. */
  timeoutSec?: number
}

/**
 * One matcher group: a `matcher` pattern (absent / `''` / `'*'` = match-all)
 * plus the command hooks that run when it matches.
 */
export interface MatcherGroup {
  matcher?: string
  hooks: CommandHook[]
}

/**
 * The dialect-neutral OUTCOME a hook produced, parsed from its exit code +
 * stdout JSON + stderr by {@link parseHookOutput}. A bridge maps this onto a
 * typed Decision for its extension point. Every field is OPTIONAL because a hook
 * may exercise any subset.
 */
export interface HookOutput {
  /** The raw process exit code (`undefined` if the hook could not be run). */
  exitCode: number | undefined
  /** Trimmed stderr — the block-reason source on a blocking (exit 2) hook. */
  stderr: string
  /**
   * Trimmed stdout, verbatim. On a clean exit a hook may emit PLAIN (non-JSON)
   * stdout that the protocol renders as output. Empty string when the hook
   * produced no stdout.
   */
  stdout: string
  /**
   * `false` ⇒ the hook asked to halt (`continue:false`); pairs with
   * {@link stopReason}. `true`/absent ⇒ proceed.
   */
  continue?: boolean
  /** Human-readable reason shown when {@link continue} is `false`. */
  stopReason?: string
  /**
   * The neutral blocking decision a hook expressed. `'block'`/`'deny'` forbid,
   * `'approve'`/`'allow'` permit, `'ask'` requests confirmation. Absent ⇒ no
   * explicit decision (exit code governs).
   */
  decision?: "approve" | "allow" | "block" | "deny" | "ask"
  /** The reason/explanation accompanying {@link decision}. */
  reason?: string
  /** Event discriminator claimed by `hookSpecificOutput`. */
  hookEventName?: string
  /** Extra context to inject for the next model request. */
  additionalContext?: string
  /** A warning surfaced to the user. */
  systemMessage?: string
  /**
   * A tool-input rewrite a hook requested. PARSED but NOT honored in Trayambak.
   */
  updatedInput?: Record<string, unknown>
}

/** The five Trayambak hook points this system supports. */
export const TRAYAMBAK_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"] as const

/** A parsed Trayambak hook result log entry. */
export interface HookResultEntry {
  sessionId: SessionId
  turn: number
  point: string
  handlerId: string
  decision: HookOutput["decision"] | "stop" | "pass"
  exitCode?: number
  stderrSummary?: string
  durationMs: number
}

export type { SessionId }

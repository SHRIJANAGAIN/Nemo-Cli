/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Helpers for durable, log-only hook events. They carry no surface intent and
 * must remain turn-enclosed and invoked/result paired.
 * @module skt/14-hooks/events
 */

import type { SessionId } from "../9-session/session.js"
import type { HookDialect, HookOutput, HookResultEntry } from "./types.js"

/** The reference default max chars for stderr summary on results. */
export const DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500

/**
 * Truncate a hook's stderr for durable results: trimmed, `undefined` when empty,
 * cut at `maxChars` with an ellipsis when over.
 * @param stderr - the hook's raw captured stderr.
 * @param maxChars - the character cap for the summary.
 * @returns the trimmed, capped summary, or `undefined` when stderr is blank.
 */
export function summarizeStderr(stderr: string, maxChars: number): string | undefined {
  const t = stderr.trim()
  if (t.length === 0) {
    return undefined
  }
  return t.length > maxChars ? t.slice(0, maxChars) + "\u2026" : t
}

/** What identifies a hook invocation across its invoked/result pair. */
export interface HookInvocation {
  /** The open turn the invocation lives inside. */
  turn: number
  /** The hook point (`PreToolUse`, `Stop`, …). */
  point: string
  /** The dialect that ran it. */
  dialect: HookDialect
  /** A stable id correlating the invoked event with its result. */
  handlerId: string
  /** The matcher-group pattern that selected it (absent for match-all). */
  matcher?: string
}

/**
 * Build a durable hook result entry from a decoded output. The recorded decision
 * is the parsed decision, then `stop` for `continue:false`, else `pass`; stderr
 * is trimmed and capped, and an absent process exit stays omitted.
 */
export function buildHookResult(
  invocation: HookInvocation,
  output: HookOutput,
  durationMs: number,
  sessionId: SessionId,
  maxChars = DEFAULT_STDERR_SUMMARY_MAX_CHARS,
): HookResultEntry {
  const stderrSummary = summarizeStderr(output.stderr, maxChars)
  return {
    sessionId,
    turn: invocation.turn,
    point: invocation.point,
    handlerId: invocation.handlerId,
    decision: output.decision ?? (output.continue === false ? "stop" : "pass"),
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(stderrSummary !== undefined ? { stderrSummary } : {}),
    durationMs,
  }
}

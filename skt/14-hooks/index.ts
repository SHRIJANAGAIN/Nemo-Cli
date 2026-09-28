/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Trayambak Hook Protocol — a dialect-neutral command hook system adapted from
 * the deepseek-harness hook-protocol package. Provides types, codec, matcher,
 * runner (with timeout + error isolation), merge, and event helpers for
 * durable hook audit logging.
 *
 * @module skt/14-hooks
 */

export { parseHookOutput } from "./codec.js"
export { matchesMatcher, matcherDiagnostic } from "./matcher.js"
export { mergeHookOutputs, type MergedDecision, type MergedHookOutcome } from "./merge.js"
export {
  runHook,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookShellExecutor,
  type RunHookOptions,
  type RunHookResult,
  type DetachedRuns,
} from "./runner.js"
export { summarizeStderr, DEFAULT_STDERR_SUMMARY_MAX_CHARS, buildHookResult, type HookInvocation } from "./events.js"
export type { CommandHook, HookDialect, HookOutput, MatcherGroup, HookResultEntry } from "./types.js"
export { TRAYAMBAK_HOOK_EVENTS } from "./types.js"

export type { SessionId } from "../9-session/session.js"

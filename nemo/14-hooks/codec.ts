/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Decode hook process outcomes for Nemo. Exit 0 may carry structured
 * JSON or plain stdout; exit 2 blocks with stderr as the reason; every other
 * exit is a non-blocking error.
 * @module nemo/14-hooks/codec
 */

import type { HookOutput } from "./types.js"

/** The exit code a hook uses to signal a blocking error (stderr → model). */
const BLOCKING_EXIT_CODE = 2

/** Read a string field from a parsed object, or `undefined` if absent/wrong type. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === "string" ? v : undefined
}

/** Read a boolean field, or `undefined` if absent/wrong type. */
function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  return typeof v === "boolean" ? v : undefined
}

/** A plain (non-null, non-array) object, or `undefined`. */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The legacy TOP-LEVEL `decision` is only `approve`/`block` — `allow`/`deny`/`ask`
 * are reserved for `hookSpecificOutput.permissionDecision`. So an out-of-band
 * `{"decision":"deny"}` is invalid and ignored here.
 */
function topLevelDecisionOf(value: string | undefined): HookOutput["decision"] {
  return value === "approve" || value === "block" ? value : undefined
}

/** A `hookSpecificOutput.permissionDecision` is `allow`/`deny`/`ask` only. */
function permissionDecisionOf(value: string | undefined): HookOutput["decision"] {
  return value === "allow" || value === "deny" || value === "ask" ? value : undefined
}

/**
 * Decode process output into a dialect-neutral hook outcome. This function is
 * total: malformed JSON remains plain stdout. When `expectedEventName` is set,
 * a missing or different `hookSpecificOutput.hookEventName` discards only its
 * event-scoped fields; top-level fields and the claimed discriminator remain.
 * @param exitCode - process exit, or `undefined` when spawn failed.
 * @param stdout - output parsed as structured JSON only on exit 0.
 * @param stderr - the captured stderr stream; becomes the blocking `reason` on exit 2.
 * @param expectedEventName - firing event used to guard hook-specific fields; omit to disable the guard.
 * @returns the dialect-neutral decoded outcome.
 */
export function parseHookOutput(
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  expectedEventName?: string,
): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()
  const output: HookOutput = { exitCode, stderr: trimmedErr, stdout: trimmedOut }

  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = "block"
    if (trimmedErr.length > 0) {
      output.reason = trimmedErr
    }
  }

  if (exitCode === 0) {
    if (trimmedOut.startsWith("{")) {
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = obj(JSON.parse(trimmedOut))
      } catch {
        parsed = undefined
      }
      if (parsed) {
        applyStructured(output, parsed, expectedEventName)
      }
    }
  }

  return output
}

/**
 * Fold a parsed structured-stdout object into `output` (mutates in place).
 * `expectedEventName` (the firing event) gates the per-event `hookSpecificOutput`
 * block: a block whose `hookEventName` names a different event — OR omits it —
 * has its event-scoped fields discarded (any present `hookEventName` is still
 * recorded).
 */
function applyStructured(output: HookOutput, parsed: Record<string, unknown>, expectedEventName?: string): void {
  const cont = bool(parsed, "continue")
  if (cont !== undefined) {
    output.continue = cont
  }
  const stopReason = str(parsed, "stopReason")
  if (stopReason !== undefined) {
    output.stopReason = stopReason
  }
  const sysMsg = str(parsed, "systemMessage")
  if (sysMsg !== undefined) {
    output.systemMessage = sysMsg
  }

  const topDecision = topLevelDecisionOf(str(parsed, "decision"))
  if (topDecision !== undefined) {
    output.decision = topDecision
  }
  const topReason = str(parsed, "reason")
  if (topReason !== undefined) {
    output.reason = topReason
  }

  const hso = obj(parsed.hookSpecificOutput)
  if (hso) {
    const eventName = str(hso, "hookEventName")
    if (eventName !== undefined) {
      output.hookEventName = eventName
    }
    if (expectedEventName !== undefined && eventName !== expectedEventName) {
      return
    }
    const permission = permissionDecisionOf(str(hso, "permissionDecision"))
    if (permission !== undefined) {
      output.decision = permission
    }
    const permissionReason = str(hso, "permissionDecisionReason")
    if (permissionReason !== undefined) {
      output.reason = permissionReason
    }
    const addCtx = str(hso, "additionalContext")
    if (addCtx !== undefined) {
      output.additionalContext = addCtx
    }
    const updated = obj(hso.updatedInput)
    if (updated !== undefined) {
      output.updatedInput = updated
    }
  }
}

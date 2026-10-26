/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Assertion evaluation — one function per assertion kind.
 *
 * Every kind is total: a malformed value fails with a reason instead of
 * throwing, so one bad task row cannot abort a suite run. A missing or
 * mistyped field is a FAILURE OF THE TASK, not a crash of the harness, and the
 * detail string says which.
 */

import type { Assertion, AssertionOutcome, RunTranscript } from "./types.js"

function contains(haystack: string, needle: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase())
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

const allAssistant = (t: RunTranscript): string => t.assistantTexts.join("\n")

function ok(assertion: Assertion): AssertionOutcome {
  return { assertion, passed: true, detail: "" }
}

function fail(assertion: Assertion, detail: string): AssertionOutcome {
  return { assertion, passed: false, detail }
}

/** Truncated preview so a 4KB model answer never lands in a report. */
function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export function evaluateAssertion(assertion: Assertion, t: RunTranscript): AssertionOutcome {
  switch (assertion.kind) {
    case "assistant-contains": {
      if (typeof assertion.value !== "string") {
        return fail(assertion, "value must be a string")
      }
      const haystack = allAssistant(t)
      return contains(haystack, assertion.value, assertion.caseSensitive === true)
        ? ok(assertion)
        : fail(assertion, `assistant output lacks "${preview(assertion.value)}"`)
    }

    case "assistant-matches": {
      if (typeof assertion.value !== "string") {
        return fail(assertion, "value must be a regex source string")
      }
      let re: RegExp
      try {
        re = new RegExp(assertion.value, assertion.flags ?? "")
      } catch (error) {
        return fail(assertion, `invalid regex: ${error instanceof Error ? error.message : String(error)}`)
      }
      const haystack = allAssistant(t)
      return re.test(haystack)
        ? ok(assertion)
        : fail(assertion, `assistant output does not match /${assertion.value}/${assertion.flags ?? ""}`)
    }

    case "assistant-lacks": {
      if (typeof assertion.value !== "string") {
        return fail(assertion, "value must be a string")
      }
      const haystack = allAssistant(t)
      return contains(haystack, assertion.value, assertion.caseSensitive === true)
        ? fail(assertion, `assistant output unexpectedly contains "${preview(assertion.value)}"`)
        : ok(assertion)
    }

    case "tool-called": {
      if (typeof assertion.name !== "string") {
        return fail(assertion, "name must be a string")
      }
      const seen = t.toolCalls.filter((n) => n === assertion.name).length
      if (seen === 0) return fail(assertion, `tool "${assertion.name}" was never called`)
      if (assertion.times !== undefined && seen !== assertion.times) {
        return fail(assertion, `tool "${assertion.name}" called ${seen}×, expected ${assertion.times}×`)
      }
      return ok(assertion)
    }

    case "tool-not-called": {
      if (typeof assertion.name !== "string") {
        return fail(assertion, "name must be a string")
      }
      return t.toolCalls.includes(assertion.name)
        ? fail(assertion, `tool "${assertion.name}" was called but must not be`)
        : ok(assertion)
    }

    case "tool-error": {
      if (typeof assertion.name !== "string") {
        return fail(assertion, "name must be a string")
      }
      return t.erroredTools.includes(assertion.name)
        ? ok(assertion)
        : fail(assertion, `tool "${assertion.name}" did not report an error`)
    }

    case "provider-calls": {
      if (typeof assertion.value !== "number" || !Number.isFinite(assertion.value)) {
        return fail(assertion, "value must be a finite number")
      }
      return t.providerCalls === assertion.value
        ? ok(assertion)
        : fail(assertion, `provider called ${t.providerCalls}×, expected ${assertion.value}×`)
    }

    case "turn-count": {
      if (typeof assertion.value !== "number" || !Number.isFinite(assertion.value)) {
        return fail(assertion, "value must be a finite number")
      }
      return t.turns === assertion.value
        ? ok(assertion)
        : fail(assertion, `${t.turns} turn(s) completed, expected ${assertion.value}`)
    }

    case "session-contains": {
      if (typeof assertion.value !== "string") {
        return fail(assertion, "value must be a string")
      }
      // The declared role union has no "system", so this branch is reached with
      // an already-valid role for well-typed callers and the guard is only a
      // runtime backstop for a task file loaded from JSON.
      const which = assertion.role
      if (which !== "user" && which !== "assistant" && which !== "tool") {
        return fail(assertion, `unknown role "${String(which)}"`)
      }
      // session-contains has no caseSensitive knob (unlike assistant-contains),
      // so it is always case-insensitive here — a task asserting on a role's
      // text should not have to restate the casing of the value it wrote.
      // `return` is load-bearing: without it this arm EVALUATES the ternary and
      // falls through to `case "event-emitted"`, so that arm's `assertion.type`
      // was still typed against the session-contains|event-emitted union.
      return contains(
        t.byRole[which],
        assertion.value,
        /*caseSensitive*/ false,
      )
        ? ok(assertion)
        : fail(assertion, `${which} messages lack "${preview(assertion.value)}"`)
    }

    case "event-emitted": {
      if (typeof assertion.type !== "string") {
        return fail(assertion, "type must be a string")
      }
      return t.eventTypes.includes(assertion.type)
        ? ok(assertion)
        : fail(assertion, `event "${assertion.type}" was never emitted`)
    }

    case "event-absent": {
      if (typeof assertion.type !== "string") {
        return fail(assertion, "type must be a string")
      }
      return t.eventTypes.includes(assertion.type)
        ? fail(assertion, `event "${assertion.type}" was emitted but must not be`)
        : ok(assertion)
    }

    case "custom": {
      // Extension point: a task may name a matcher this build does not know.
      // Reported as a failure with the name so the gap is visible in the run
      // rather than silently passing.
      return fail(assertion, `unknown assertion matcher "${String(assertion.name)}"`)
    }

    default: {
      const kind = (assertion as { kind?: unknown }).kind
      return fail(assertion, `unknown assertion kind "${String(kind)}"`)
    }
  }
}

export function evaluateAll(assertions: readonly Assertion[], t: RunTranscript): AssertionOutcome[] {
  return assertions.map((assertion) => evaluateAssertion(assertion, t))
}

export { countOccurrences, contains, preview }
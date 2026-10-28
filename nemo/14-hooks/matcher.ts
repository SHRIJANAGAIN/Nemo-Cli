/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Matcher for Nemo hook patterns. Patterns are unanchored regexes.
 * Missing, empty, and `*` match all. Runtime matching contains invalid regexes
 * as non-matches; config parsers use {@link matcherDiagnostic} to reject them
 * with a diagnostic.
 * @module nemo/14-hooks/matcher
 */

/**
 * Validate one matcher before a bridge accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined): string | undefined {
  if (isMatchAll(matcher)) {
    return undefined
  }
  const pattern = matcher as string
  return compileRegex(pattern) === undefined ? `invalid Nemo regex matcher ${JSON.stringify(pattern)}` : undefined
}

/**
 * Whether `matcher` selects `query` under Nemo. All non-empty patterns are
 * unanchored regexes. Invalid regexes return `false` rather than throwing; config
 * parsers surface them through {@link matcherDiagnostic} before use.
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid regex.
 */
export function matchesMatcher(matcher: string | undefined, query: string): boolean {
  if (isMatchAll(matcher)) {
    return true
  }
  const pattern = matcher as string
  const regex = compileRegex(pattern)
  if (regex === undefined) {
    return false
  }
  return regex.test(query)
}

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === "" || matcher === "*"
}

/** Compile an unanchored matcher regex; invalid patterns return `undefined`. */
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch (_syntaxError) {
    return undefined
  }
}

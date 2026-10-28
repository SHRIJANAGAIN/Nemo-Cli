/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Character loops instead of /\/+$/ style regexes: no backtracking on input. */

export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

export function trimSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value
}

/** Strip one pair of wrapping single or double quotes. */
export function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  if ((first === '"' || first === "'") && value[value.length - 1] === first) {
    return value.slice(1, -1)
  }
  return value
}

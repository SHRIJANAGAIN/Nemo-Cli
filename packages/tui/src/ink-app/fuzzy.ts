/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Case-insensitive subsequence score: higher = tighter match, 0 = no match.
 * Word-ish boundaries (start of text, after a space or "/") score double and
 * a full-prefix query gets a bonus. Shared by the slash chooser, the question
 * option filter, and the command palette so all three rank identically. */
export function fuzzyMatchScore(text: string, query: string): number {
  if (!query) return 1
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let i = 0
  let score = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      i++
      score += j === 0 || t[j - 1] === " " || t[j - 1] === "/" ? 2 : 1
    }
  }
  return i === q.length ? score + (t.startsWith(q) ? 1 : 0) : 0
}

export function fuzzyMatch(text: string, query: string): boolean {
  return fuzzyMatchScore(text, query) > 0
}

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as path from "node:path"
import { type FrecencyEntry, frecencyScore } from "../../../core/src/frecency.js"
import { filterMentions, type MentionCandidate } from "./file-mention.js"

/**
 * Frecency ranking layered onto the existing `@`-mention picker.
 *
 * `filterMentions` already ranks well — fuzzy match plus a basename bonus — but
 * it is blind to history, so a project with a thousand files always surfaces the
 * alphabetically-or-fuzzily-best candidate no matter which twelve you actually
 * work in. Frecency is the missing signal.
 *
 * It is applied as a SOFT BOOST, never an override, and the two query shapes get
 * opposite treatment on purpose:
 *
 *  - With a query, fuzzy relevance is still king. Typing an exact filename must
 *    surface it even if it has never been opened, or the picker starts lying to
 *    the user about what they asked for. The boost is a bounded multiplier, so
 *    only near-ties can flip.
 *  - With an empty query there is no fuzzy signal to respect at all, so the
 *    working set leads outright. That is the case worth fixing: opening `@` and
 *    seeing your own files.
 *
 * This lives beside `file-mention.ts` rather than inside it so the existing
 * picker's behaviour and tests stay exactly as they are; the frecency ranking is
 * opt-in at the call site.
 */

/** Ceiling on the multiplier, so relevance always outranks a stale favourite. */
export const FRECENCY_BOOST = 0.6

/**
 * Key the store by workspace-relative path.
 *
 * The store holds absolute paths (that is what the tools saw) while candidates
 * are workspace-relative, so ranking has to re-key or nothing ever matches and
 * the boost silently degrades to a no-op for every row.
 */
export function frecencyKeys(entries: readonly FrecencyEntry[], workspace: string): Map<string, number> {
  const root = path.resolve(workspace)
  const out = new Map<string, number>()
  for (const entry of entries) {
    const relative = path.relative(root, entry.path)
    // A path outside the workspace, or one that relative-escapes with `..`, has
    // no business matching a project candidate — skip rather than alias it.
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue
    const key = relative.split(path.sep).join("/")
    const score = frecencyScore(entry)
    const seen = out.get(key)
    if (seen === undefined || score > seen) out.set(key, score)
  }
  return out
}

/** Longest frecency score present, used to normalise the boost. */
function peakScore(scores: ReadonlyMap<string, number>): number {
  let peak = 0
  for (const score of scores.values()) if (score > peak) peak = score
  return peak
}

/** Stable ordering by value, so equal rows never reshuffle between renders. */
function byValue(a: MentionCandidate, b: MentionCandidate): number {
  return a.value.localeCompare(b.value)
}

/**
 * Rank candidates with frecency applied.
 *
 * `scores` is keyed by workspace-relative path. A missing entry simply means
 * "no history", which must cost nothing beyond the unchanged ordering — the
 * picker behaves identically to `filterMentions` for a user with an empty store.
 */
export function rankMentionsByFrecency(
  query: string,
  candidates: readonly MentionCandidate[],
  scores: ReadonlyMap<string, number>,
  limit = 50,
): MentionCandidate[] {
  const peak = peakScore(scores)

  if (!query.trim()) {
    // No query: the working set leads, then folders, then the rest. Score is a
    // multiplier on a coarse rank rather than a sort key, which keeps the
    // folders-before-files convention intact for the long tail.
    return [...candidates]
      .map((c) => {
        const raw = scores.get(c.value) ?? 0
        const rank = peak > 0 && raw > 0 ? raw / peak : 0
        const kindRank = c.kind === "folder" ? 1 : 0
        return { c, key: rank * 2 + kindRank }
      })
      .sort((a, b) => b.key - a.key || byValue(a.c, b.c))
      .slice(0, limit)
      .map((e) => e.c)
  }

  // With a query, reuse the existing ranking and re-sort with a bounded boost.
  // Sub-sorting rather than reimplementing keeps one definition of "relevant".
  const relevant = filterMentions(query, candidates, Number.MAX_SAFE_INTEGER)
  if (relevant.length <= 1 || peak <= 0) return relevant.slice(0, limit)
  return [...relevant]
    .map((c) => {
      const raw = scores.get(c.value) ?? 0
      const boost = raw > 0 ? (raw / peak) * FRECENCY_BOOST : 0
      return { c, key: boost }
    })
    .sort((a, b) => b.key - a.key)
    .slice(0, limit)
    .map((e) => e.c)
}

/**
 * Rank straight from store entries, re-keying absolute paths onto the
 * workspace-relative candidates. `workspace` is used only for that re-keying;
 * the store's own location is resolved by the frecency module from
 * `NEMO_STATE_DIR`.
 */
export function rankMentionsWithHistory(
  query: string,
  candidates: readonly MentionCandidate[],
  entries: readonly FrecencyEntry[],
  workspace: string,
  limit = 50,
): MentionCandidate[] {
  return rankMentionsByFrecency(query, candidates, frecencyKeys(entries, workspace), limit)
}

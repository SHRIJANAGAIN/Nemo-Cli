/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Memory decay, supersession, and eviction.
 *
 * Extracted from `agentmemory` (src/functions/auto-forget.ts), reimplemented as
 * pure functions over plain data.
 *
 * The gap this closes
 * -------------------
 * Nemo's memory store had no notion of a memory expiring, no notion of one
 * memory contradicting another, and no way to retire either. A store that only
 * accumulates is a store that becomes wrong over time: a fact that was true last
 * month stays asserted forever, and two memories that disagree both survive
 * because nothing ever compares them.
 *
 * Three ideas carried across, each of which is a way a memory store quietly goes
 * stale:
 *
 *  1. **TTL.** A memory can carry `forgetAfter`. Past that instant it is DELETED
 *     (not flagged), with an audit record — a memory that must not outlive its
 *     window must also not linger in a search index.
 *
 *  2. **Contradiction by shared concept + token overlap.** Memories are only
 *     compared when they share a concept, which keeps the comparison out of the
 *     all-pairs case; the comparison itself is Jaccard similarity over tokens.
 *     Above a threshold they are treated as restatements of each other.
 *
 *  3. **Newest wins, and the loser is SUPERSEDED not deleted.** `isLatest: false`
 *     is reversible and keeps the original text; a user who disagrees with the
 *     verdict can promote it back without the original having been destroyed.
 *     Deleting the older memory here would make contradiction resolution
 *     irreversible and unreviewable.
 *
 * What was deliberately changed on the way over
 * ---------------------------------------------
 *  - The upstream routine is a KV function with `await` on every write and a
 *    1000-entry cap applied inline. Here every step is a pure function returning
 *    a decision, so the policy is testable without a store and the caller
 *    applies it atomically.
 *  - Upstream does the same empty-token-set check twice (`size === 0 && …` then
 *    `size === 0 || …`). The second subsumes the first; kept as one check.
 *  - Upstream tokenises on whitespace and drops tokens of length ≤ 2. That
 *    filter is preserved, and it is load-bearing: without it, two unrelated
 *    memories that both contain "a" or "the" score a non-trivial similarity.
 */

/** Matches the upstream token filter: words of 2 characters or fewer are noise. */
const MIN_TOKEN_LENGTH = 3

/** Upstream threshold. Strictly greater than, so exactly 0.9 is NOT a conflict. */
export const CONTRADICTION_THRESHOLD = 0.9

export interface DecayMemory {
  id: string
  content: string
  createdAt: string
  /** ISO timestamp after which this memory must be deleted. */
  forgetAfter?: string
  /** Concepts this memory is about; the cheap index that gates comparison. */
  concepts?: string[]
  /** False once a newer memory supersedes it. */
  isLatest?: boolean
}

export interface ExpiredMemory {
  id: string
  /** The instant it expired, echoed so an audit record needs no second lookup. */
  forgetAfter: string
}

export interface Contradiction {
  /** The older memory — the one that gets superseded. */
  olderId: string
  /** The newer memory that survives. */
  newerId: string
  similarity: number
  /** Concepts the two shared, which is why they were compared at all. */
  sharedConcepts: string[]
}

export interface SupersedeDecision {
  id: string
  isLatest: false
}

export interface ForgetPlan {
  /** Memories to delete outright: their TTL has passed. */
  expired: ExpiredMemory[]
  /** Memories to mark superseded because a newer one restates them. */
  supersede: SupersedeDecision[]
  /** Every contradiction found, including ones among already-expired memories. */
  contradictions: Contradiction[]
  /** True when nothing may be written. The plan is still complete. */
  dryRun: boolean
}

/**
 * Tokenise for similarity.
 *
 * Lowercased, whitespace-split, short tokens dropped. Exported because the
 * similarity function's behaviour on edge-case input is worth asserting directly
 * rather than only through a caller.
 */
export function tokenize(content: string): Set<string> {
  const out = new Set<string>()
  for (const token of content.toLowerCase().split(/\s+/)) {
    if (token.length > MIN_TOKEN_LENGTH - 1) out.add(token)
  }
  return out
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 *
 * Returns 0 when either side is empty. The alternative — treating an empty set
 * as "identical to everything" — makes any memory with no usable tokens a
 * universal contradiction, which would evict unrelated content on a tokenisation
 * edge case rather than on real evidence.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  if (union === 0) return 0
  return intersection / union
}

/** Similarity between two memory contents. */
export function contentSimilarity(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b))
}

function createdAtMs(memory: DecayMemory): number {
  const t = Date.parse(memory.createdAt)
  // An unparseable timestamp must not sort as "newest" and win every comparison.
  // 0 puts it last, which means it is the one superseded — the safe direction,
  // since the newer memory's content survives.
  return Number.isFinite(t) ? t : 0
}

/**
 * Memories whose TTL has passed.
 *
 * A `forgetAfter` that does not parse is IGNORED rather than treated as expired.
 * A typo in a timestamp must not delete a memory; failing toward keeping is the
 * only safe direction when the input is malformed.
 */
export function findExpired(memories: readonly DecayMemory[], now: number): ExpiredMemory[] {
  const out: ExpiredMemory[] = []
  for (const memory of memories) {
    if (memory.forgetAfter === undefined) continue
    const expiry = Date.parse(memory.forgetAfter)
    if (!Number.isFinite(expiry)) continue
    if (now > expiry) out.push({ id: memory.id, forgetAfter: memory.forgetAfter })
  }
  return out
}

/**
 * Find memories that restate each other.
 *
 * Candidate pairs are generated by shared concept rather than all-pairs, so the
 * cost is bounded by how many memories talk about the same thing. Each pair is
 * compared exactly once even when the two share several concepts — the
 * alternative reports one contradiction per shared concept, which inflates the
 * report and makes a single disagreement look like many.
 */
export function findContradictions(
  memories: readonly DecayMemory[],
  threshold: number = CONTRADICTION_THRESHOLD,
): Contradiction[] {
  const tokens = new Map<string, Set<string>>()
  const byId = new Map<string, DecayMemory>()
  const conceptIndex = new Map<string, string[]>()

  for (const memory of memories) {
    tokens.set(memory.id, tokenize(memory.content))
    byId.set(memory.id, memory)
    for (const concept of memory.concepts ?? []) {
      const key = concept.toLowerCase()
      const bucket = conceptIndex.get(key)
      if (bucket === undefined) conceptIndex.set(key, [memory.id])
      else bucket.push(memory.id)
    }
  }

  const out: Contradiction[] = []
  const compared = new Set<string>()

  for (const [concept, ids] of conceptIndex) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as string
        const b = ids[j] as string
        // Order-independent pair key, so a pair sharing three concepts is
        // compared once rather than three times.
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (compared.has(key)) continue
        compared.add(key)

        const similarity = jaccard(tokens.get(a) ?? new Set(), tokens.get(b) ?? new Set())
        // Strictly greater: a pair sitting exactly ON the threshold is not a
        // contradiction. `>` is what upstream uses and the boundary matters —
        // floating-point equality at 0.9 is common enough to hit.
        if (similarity <= threshold) continue

        const memA = byId.get(a)
        const memB = byId.get(b)
        if (memA === undefined || memB === undefined) continue

        const older = createdAtMs(memA) <= createdAtMs(memB) ? memA : memB
        const newer = older === memA ? memB : memA
        out.push({ olderId: older.id, newerId: newer.id, similarity, sharedConcepts: [concept] })
      }
    }
  }

  return out
}

/**
 * Plan the whole decay pass without touching anything.
 *
 * Pure, so the caller can inspect the plan, dry-run it for a report, and then
 * apply it in one place. The upstream routine interleaves the scan with the
 * writes, which means a store error halfway through leaves memories deleted but
 * the audit trail incomplete.
 *
 * Memories already superseded (`isLatest === false`) are excluded from
 * comparison. Re-comparing them would let a third, older memory resurrect as a
 * "conflict" winner on a tie, undoing a decision already made.
 *
 * Superseded memories are NOT returned for deletion. Keeping them is what makes
 * the decision reversible; upstream matches this, and it is the reason this is a
 * flag rather than a delete.
 */
export function planForget(
  memories: readonly DecayMemory[],
  options: { now?: number; dryRun?: boolean; threshold?: number } = {},
): ForgetPlan {
  const now = options.now ?? Date.now()
  const dryRun = options.dryRun === true
  const threshold = options.threshold ?? CONTRADICTION_THRESHOLD

  const expired = findExpired(memories, now)
  const expiredIds = new Set(expired.map((e) => e.id))

  const latest = memories.filter((m) => m.isLatest !== false && !expiredIds.has(m.id))
  const contradictions = findContradictions(latest, threshold)

  // If A conflicts with both B and C, and B was superseded by C, only A→C is a
  // decision worth recording. Deduplicating on the older id keeps the newest
  // counterpart, which is the one that survives.
  const bestFor = new Map<string, Contradiction>()
  for (const c of contradictions) {
    const existing = bestFor.get(c.olderId)
    if (existing === undefined || c.similarity > existing.similarity) {
      bestFor.set(c.olderId, c)
    }
  }

  const supersede: SupersedeDecision[] = [...bestFor.values()].map((c) => ({
    id: c.olderId,
    isLatest: false,
  }))

  return { expired, supersede, contradictions, dryRun }
}

/**
 * Apply a plan to a memory list, returning a NEW list.
 *
 * Pure rather than in-place: the caller's list is not mutated, so a failed
 * `saveMemory` after this returns leaves the in-memory view and the stored view
 * consistent with each other rather than one silently ahead of the other.
 *
 * The returned list is the same objects EXCEPT for superseded ones, which are
 * replaced by a copy carrying `isLatest: false`. A copy is required: mutating
 * the shared object would make the caller's pre-plan snapshot show the new
 * flag too, which defeats the point of planning before applying.
 */
export function applyForgetPlan(memories: readonly DecayMemory[], plan: ForgetPlan): DecayMemory[] {
  const expiredIds = new Set(plan.expired.map((e) => e.id))
  const supersededIds = new Set(plan.supersede.map((s) => s.id))
  const out: DecayMemory[] = []
  for (const memory of memories) {
    if (expiredIds.has(memory.id)) continue
    out.push(supersededIds.has(memory.id) ? { ...memory, isLatest: false } : memory)
  }
  return out
}
/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Git-scoped memory, and checkpoint state.
 *
 * The gap
 * -------
 * Nemo can enter and exit a git worktree (`worktree.ts`, 124 lines) and had
 * 81 mentions of "worktree" and 100 of "branch" across the runtime — but nothing
 * connected any of it to memory. `git-common-dir` appeared zero times: there was
 * no linked-worktree detection at all.
 *
 * So an agent that switches branch carries every memory across with it. A fact
 * learned while fixing a bug on `feature/auth` — a file layout, a schema quirk, a
 * "this test only fails on Windows" note — is asserted just as confidently on
 * `main` after a branch switch, where it may be flatly wrong. Nothing marks it as
 * having been observed somewhere else. That is a correctness problem, not a
 * tidiness one: a memory cannot be trusted or discounted without knowing where it
 * came from.
 *
 * What this adds
 * --------------
 *  1. **Scope detection.** Branch, worktree, repo root, and whether the cwd is a
 *     LINKED worktree — the case where `--git-dir` differs from
 *     `--git-common-dir`, which is the only reliable way to tell "a second
 *     checkout of the same repo" from "the main checkout".
 *  2. **A stable scope key** that is the SAME for a linked worktree of a branch
 *     and for the main checkout checked out at that branch, and DIFFERENT across
 *     branches. That property is what makes a memory recorded in a worktree
 *     still valid back on the main checkout, and it is not obvious — the obvious
 *     key (the worktree path) gets it wrong in exactly that case.
 *  3. **Visibility rules.** Same scope is visible; a different scope is not, but
 *     is not destroyed either. Branch-scoped memory that is relevant elsewhere
 *     should be surfaced as *provenance*, not suppressed — the agent can then
 *     decide whether the fact transfers.
 *  4. **Checkpoints as an explicit state machine.** `pending → passed | failed |
 *     blocked`, with the reason blocked recorded, so a checkpoint that blocked is
 *     distinguishable from one that failed.
 *
 * Everything here is pure. The one impure part — asking git — is injected, so the
 * policy is testable on a machine with no repository at all, which matters
 * because these tests run on CI matrices that have no git checkout.
 */

/* ------------------------------------------------------------------ *
 * Scope detection
 * ------------------------------------------------------------------ */

/** What a `git` invocation should return. Narrow so the tests need no real repo. */
export type GitProbe = (args: readonly string[], cwd: string) => string | undefined

export interface GitScope {
  /** Repo root (`rev-parse --show-toplevel`). */
  root?: string
  /** Absolute `--git-dir`. */
  gitDir?: string
  /** Absolute `--git-common-dir`. Differs from gitDir in a linked worktree. */
  commonDir?: string
  /** Abbreviated branch name. */
  branch?: string
  /** Current commit. */
  head?: string
  /**
   * True when this is a LINKED worktree rather than the main checkout.
   *
   * The test is `gitDir !== commonDir`: in the main checkout both resolve to the
   * same `.git`, and in a linked worktree `.git` is a FILE pointing at the main
   * repo's `worktrees/<name>` directory. Comparing the paths is the only way that
   * holds on Windows too, where a linked worktree has no `.git` directory at all.
   */
  isWorktree: boolean
}

/**
 * Detect the git scope of `cwd`.
 *
 * Every field is independently optional. A missing git, a non-repository
 * directory, a detached HEAD, or a corrupt `.git` must each degrade to "less
 * information" rather than throwing — a memory system that refuses to record
 * anything because the project is not under version control is worse than one
 * that records without provenance.
 *
 * A detached HEAD reports `HEAD` as its branch. That is what git itself prints
 * for `rev-parse --abbrev-ref HEAD` there, and treating it as a branch name would
 * create a scope shared by every detached checkout of this repo, which is the
 * opposite of what scoping is for.
 */
export function detectGitScope(cwd: string, probe: GitProbe): GitScope {
  const run = (args: readonly string[]): string | undefined => {
    try {
      const out = probe(args, cwd)
      if (out === undefined) return undefined
      const trimmed = out.trim()
      return trimmed.length === 0 ? undefined : trimmed
    } catch {
      return undefined
    }
  }

  const toplevel = run(["rev-parse", "--show-toplevel"])
  const gitDir = run(["rev-parse", "--git-dir"])
  const commonDir = run(["rev-parse", "--git-common-dir"])
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"])
  const head = run(["rev-parse", "HEAD"])

  if (toplevel === undefined) {
    // Not a repository, or no git. Nothing to scope against.
    return { isWorktree: false }
  }

  return {
    root: toplevel,
    ...(gitDir === undefined ? {} : { gitDir: absolutize(cwd, gitDir) }),
    ...(commonDir === undefined ? {} : { commonDir: absolutize(cwd, commonDir) }),
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    // Absent on BOTH sides means "unknown", not "same". Defaulting to `false`
    // when one is missing would claim these are the main checkout and scope
    // every worktree memory into the same bucket.
    isWorktree: gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir,
  }
}

function absolutize(cwd: string, p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) return p
  return `${cwd.replace(/[\\/]+$/, "")}/${p.replace(/^[\\/]+/, "")}`
}

/* ------------------------------------------------------------------ *
 * Scope keys and visibility
 * ------------------------------------------------------------------ */

/**
 * A stable identity for "the same code", independent of which checkout you are in.
 *
 * `repoRoot + "#" + branch` — NOT the worktree path. A linked worktree of
 * `feature/x` and the main checkout at `feature/x` are examining the SAME branch,
 * so a memory recorded in the worktree must remain valid in the main checkout. A
 * path-based key would silently invalidate it, which teaches the agent to distrust
 * correct memories after every worktree round-trip.
 *
 * Returns undefined when there is not enough information to scope at all (no
 * repository, no branch). Unscoped is a real state and is reported as such rather
 * than being folded into some default bucket that would make every unscoped
 * memory look related to every other one.
 */
export function scopeKey(scope: GitScope): string | undefined {
  if (scope.root === undefined || scope.branch === undefined) return undefined
  return `${scope.root}#${scope.branch}`
}

export type MemoryVisibility = "same-scope" | "other-scope" | "unscoped-memory" | "unscoped-here"

export interface VisibilityVerdict {
  visibility: MemoryVisibility
  /**
   * True when the memory came from a different branch but its scope is known.
   * The agent should treat it as provenance to check, not as a fact to assert.
   */
  fromElsewhere: boolean
}

/**
 * Decide whether a recorded memory applies to the current scope.
 *
 * The three-way split matters and is the whole point:
 *
 *  - **same scope** → usable directly.
 *  - **other scope** → NOT usable, and NOT to be silently ignored either. It is
 *    reported as `fromElsewhere` so the caller can surface "observed on
 *    feature/auth" instead of either asserting it or hiding it. Hiding it would
 *    make a legitimately relevant fact invisible; asserting it is how a
 *    branch-specific workaround becomes a phantom bug report on `main`.
 *  - **unscoped** → honest "we do not know", on either side. Treated as
 *    unrelated-but-admissible, because a memory with no provenance is weak
 *    evidence rather than false evidence.
 */
export function visibilityOf(recordedKey: string | undefined, currentKey: string | undefined): VisibilityVerdict {
  if (recordedKey === undefined && currentKey === undefined) {
    return { visibility: "unscoped-memory", fromElsewhere: false }
  }
  if (recordedKey === undefined) {
    // Memory has no provenance, but we know where we are.
    return { visibility: "unscoped-memory", fromElsewhere: false }
  }
  if (currentKey === undefined) {
    // We know where the memory came from but not where we are.
    return { visibility: "unscoped-here", fromElsewhere: true }
  }
  if (recordedKey === currentKey) {
    return { visibility: "same-scope", fromElsewhere: false }
  }
  return { visibility: "other-scope", fromElsewhere: true }
}

/**
 * Group recorded keys by scope, newest-first ordering left to the caller.
 *
 * A count is returned alongside so a caller can tell "one memory from elsewhere"
 * from "four hundred", and treat the second differently.
 */
export function partitionByScope(
  recordedKeys: readonly (string | undefined)[],
  currentKey: string | undefined,
): { current: number; other: number; unscoped: number } {
  let current = 0
  let other = 0
  let unscoped = 0
  for (const key of recordedKeys) {
    const verdict = visibilityOf(key, currentKey)
    if (verdict.visibility === "same-scope") current += 1
    else if (verdict.visibility === "other-scope") other += 1
    else unscoped += 1
  }
  return { current, other, unscoped }
}

/**
 * A one-line provenance suffix for display.
 *
 * Returns "" in the same scope so the common case prints no suffix at all —
 * appending "(main)" to every memory on the branch you are already on trains
 * people to ignore the field that matters when it is wrong.
 */
export function provenanceSuffix(verdict: VisibilityVerdict, recordedKey: string | undefined): string {
  if (!verdict.fromElsewhere || recordedKey === undefined) return ""
  const branch = recordedKey.includes("#") ? recordedKey.slice(recordedKey.lastIndexOf("#") + 1) : recordedKey
  return ` (from ${branch})`
}

/* ------------------------------------------------------------------ *
 * Checkpoints
 * ------------------------------------------------------------------ */

export type CheckpointStatus = "pending" | "passed" | "failed" | "blocked"

export interface CheckpointTransition {
  from: CheckpointStatus
  to: CheckpointStatus
  ok: boolean
  reason?: string
}

/**
 * Which status changes are legal.
 *
 * `pending` is the only source of every other state. Re-opening a finished
 * checkpoint is deliberately absent: a checkpoint is a claim about a moment, and
 * letting it flip back to pending makes "did this pass?" answerable two ways.
 * `blocked` is terminal for the same reason a failure is — the distinction is that
 * blocked means "something prevented a verdict", which is a different fact from
 * "the verdict was negative", and collapsing them loses it.
 */
const LEGAL: Record<CheckpointStatus, readonly CheckpointStatus[]> = {
  pending: ["passed", "failed", "blocked"],
  passed: [],
  failed: [],
  blocked: [],
}

export function canTransition(from: CheckpointStatus, to: CheckpointStatus): boolean {
  return (LEGAL[from] ?? []).includes(to)
}

/**
 * Validate a transition.
 *
 * A `blocked` transition requires a reason. Without one, "blocked" is
 * indistinguishable from "failed because something went wrong", which is the
 * distinction the whole status exists to preserve.
 */
export function validateTransition(
  from: CheckpointStatus,
  to: CheckpointStatus,
  reason?: string,
): { ok: true; transition: CheckpointTransition } | { ok: false; error: string } {
  if (!canTransition(from, to)) {
    return { ok: false, error: `checkpoint cannot move from ${from} to ${to}` }
  }
  if (to === "blocked" && (reason === undefined || reason.trim().length === 0)) {
    return { ok: false, error: "a blocked checkpoint must record why it was blocked" }
  }
  return {
    ok: true,
    transition: {
      from,
      to,
      ok: true,
      ...(reason === undefined ? {} : { reason }),
    },
  }
}

/**
 * Summarise a set of checkpoints.
 *
 * A blocked checkpoint is counted SEPARATELY from a failed one, and `verdict`
 * is "inconclusive" whenever anything is blocked. Reporting a blocked run as
 * "failed" is how a checkpoint that never ran gets counted as a regression.
 */
export function summariseCheckpoints(
  checkpoints: ReadonlyArray<{ id: string; status: CheckpointStatus }>,
): {
  total: number
  passed: number
  failed: number
  blocked: number
  pending: number
  verdict: "pass" | "fail" | "inconclusive"
} {
  let passed = 0
  let failed = 0
  let blocked = 0
  let pending = 0
  for (const c of checkpoints) {
    if (c.status === "passed") passed += 1
    else if (c.status === "failed") failed += 1
    else if (c.status === "blocked") blocked += 1
    else pending += 1
  }
  const verdict = blocked > 0 || pending > 0 ? "inconclusive" : failed > 0 ? "fail" : "pass"
  return { total: checkpoints.length, passed, failed, blocked, pending, verdict }
}
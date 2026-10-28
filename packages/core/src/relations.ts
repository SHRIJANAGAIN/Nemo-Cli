/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Relations between memories: typed edges, dependency cycles, and blocked-work
 * propagation.
 *
 * The gap
 * -------
 * Nemo memories were a flat list. Two things that flatness costs:
 *
 *  - **No way to say one memory contradicts another.** `memory_decay` can
 *    DETECT a contradiction by token overlap, but it has no way to record a
 *    correction the user made deliberately — "no, we moved to pnpm", stated
 *    once, with the old fact linked to the new one.
 *  - **No dependency structure at all.** If a step depends on another, nothing
 *    tracks that, so a failure cannot propagate and a cycle cannot be detected.
 *    A cycle in a `requires` graph is not a cosmetic problem: it makes "can this
 *    run?" unanswerable, and the usual implementation loops forever trying.
 *
 * What this adds
 * --------------
 *  1. **A typed relation vocabulary.** Every edge says which relation it is, so
 *     `supersedes` is never confused with `related_to`, and a query for
 *     "what blocks this" is a filter rather than a guess.
 *  2. **Cycle detection** over the dependency relations, reported with the actual
 *     path. A cycle is reported as the chain that forms it, because "there is a
 *     cycle somewhere" is not actionable and "A requires B requires C requires A"
 *     is.
 *  3. **Transitive `supersedes`.** If A supersedes B and B supersedes C, then A
 *     supersedes C. Transitivity matters here specifically: a user who corrects a
 *     correction expects the ORIGINAL to be dead, and without closure it stays
 *     reachable.
 *  4. **Blocking propagation.** Anything transitively `blocked_by` a failed or
 *     blocked node is itself blocked. Without propagation a failing dependency
 *     silently produces work that can only fail later and less clearly.
 *
 * Everything is pure and takes plain data. No store, no clock beyond an injected
 * timestamp, no server — which is what makes the graph logic testable at all.
 */

/** How two memories relate. */
export type Relation =
  /** A corrects B. B is historical. Transitive. */
  | "supersedes"
  /** A and B cannot both be believed. Symmetric. */
  | "contradicts"
  /** A generalises B. B stays valid. */
  | "extends"
  /** A is the conclusion drawn from B. */
  | "derives"
  | "related_to"
  /** A needs B to have happened or to be true. Directional and acyclic. */
  | "requires"
  /** A is waiting on B. The inverse of `requires`; both may be present. */
  | "blocked_by"
  /** A exists because of B. Directional. */
  | "caused_by"

/**
 * Relations whose direction matters for traversal.
 *
 * `related_to` and `contradicts` are deliberately absent: they carry no ordering,
 * so treating them as edges to follow would invent a hierarchy that is not there.
 */
const DIRECTED: ReadonlySet<Relation> = new Set<Relation>([
  "supersedes",
  "extends",
  "derives",
  "requires",
  "blocked_by",
  "caused_by",
])

/** Relations that must never form a cycle. */
const DEPENDENCY: ReadonlySet<Relation> = new Set<Relation>(["requires", "blocked_by"])

export interface Edge {
  from: string
  to: string
  relation: Relation
}

export type NodeState = "ok" | "failed" | "blocked"

/**
 * Validate one edge.
 *
 * Self-edges are rejected for every relation. `A supersedes A` looks harmless and
 * is a cycle of length one; allowing it makes every traversal that does not
 * special-case it loop.
 */
export function validateEdge(edge: Edge): { ok: true } | { ok: false; error: string } {
  if (edge.from.length === 0 || edge.to.length === 0) {
    return { ok: false, error: "an edge needs both endpoints" }
  }
  if (edge.from === edge.to) {
    // A cycle of length one is still a cycle, and it is the easiest one to write
    // by accident.
    return { ok: false, error: `self-edge on ${edge.from} (${edge.relation})` }
  }
  return { ok: true }
}

/** Keep only the edges that are individually valid. */
export function validEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter((e) => validateEdge(e).ok)
}

/** All nodes mentioned by either endpoint. */
export function nodesOf(edges: readonly Edge[]): string[] {
  const set = new Set<string>()
  for (const e of edges) {
    set.add(e.from)
    set.add(e.to)
  }
  return [...set]
}

/**
 * Direct successors of `node` under `relations`.
 *
 * An optional `exclude` drops a set of edges, which is how cycle-aware traversal
 * is built: find a path, cut it, look for another, and the concatenation is a
 * witness.
 */
export function successors(
  edges: readonly Edge[],
  node: string,
  relations: readonly Relation[],
  exclude?: ReadonlySet<Edge>,
): string[] {
  const out: string[] = []
  for (const edge of edges) {
    if (exclude?.has(edge)) continue
    if (edge.from !== node) continue
    if (!relations.includes(edge.relation)) continue
    out.push(edge.to)
  }
  return out
}

/**
 * Every node reachable from `start` under `relations`, EXCLUDING `start` unless
 * a cycle brings it back.
 *
 * Iterative with an explicit stack rather than recursion: a dependency chain in
 * a real repository is routinely 30+ deep, and a recursive version is one
 * pathological graph away from a stack overflow on the machine that least expects
 * it.
 */
export function reachable(
  edges: readonly Edge[],
  start: string,
  relations: readonly Relation[],
): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const next of successors(edges, current, relations)) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return seen
}

export interface CycleWitness {
  /** The chain, as ids, with the first id repeated at the end. */
  path: string[]
  /** The relations traversed, one fewer than `path`. */
  relations: Relation[]
}

/**
 * Find ONE cycle among the dependency relations.
 *
 * Reports the actual path. "There is a cycle somewhere" is not actionable; the
 * user needs to know which chain to break, and usually the answer is "the last
 * edge added", which only the path reveals.
 *
 * Iterative depth-first search with an explicit stack and a per-node cursor, so a
 * long chain cannot blow the call stack. Returns undefined when the graph is
 * acyclic, which is the common case and must not be treated as an error.
 */
export function findDependencyCycle(
  edges: readonly Edge[],
  relations: readonly Relation[] = [...DEPENDENCY],
): CycleWitness | undefined {
  const relevant = validEdges(edges).filter((e) => relations.includes(e.relation))

  const byNode = new Map<string, string[]>()
  for (const e of relevant) {
    const bucket = byNode.get(e.from)
    if (bucket === undefined) byNode.set(e.from, [e.to])
    else bucket.push(e.to)
  }

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map<string, number>()
  for (const node of nodesOf(relevant)) colour.set(node, WHITE)

  for (const start of [...colour.keys()]) {
    if (colour.get(start) !== WHITE) continue
    // Stack entries carry the node, its relation to the next frame, and a cursor
    // into its successors — a manual recursion so a deep graph cannot overflow.
    const path: string[] = [start]
    const viaRelations: Relation[] = []
    const stack: Array<{ node: string; cursor: number }> = [{ node: start, cursor: 0 }]
    colour.set(start, GREY)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; cursor: number }
      const nexts = byNode.get(frame.node) ?? []
      if (frame.cursor >= nexts.length) {
        colour.set(frame.node, BLACK)
        stack.pop()
        path.pop()
        viaRelations.pop()
        continue
      }
      const next = nexts[frame.cursor] as string
      frame.cursor += 1
      const edge = relevant.find((e) => e.from === frame.node && e.to === next)

      const state = colour.get(next)
      if (state === GREY) {
        // Back edge: the chain from `next` to the top of the stack, closed.
        const startIndex = path.indexOf(next)
        const cyclePath = path.slice(startIndex)
        const cycleRels = viaRelations.slice(startIndex)
        if (edge !== undefined) cycleRels.push(edge.relation)
        return { path: [...cyclePath, next], relations: cycleRels }
      }
      if (state === BLACK) continue

      colour.set(next, GREY)
      path.push(next)
      viaRelations.push(edge?.relation ?? "related_to")
      stack.push({ node: next, cursor: 0 })
    }
  }
  return undefined
}

/**
 * Transitive closure of `supersedes`.
 *
 * If A supersedes B and B supersedes C, then A supersedes C. This is not
 * decoration: a user who corrected a correction expects the ORIGINAL to be dead,
 * and without closure it stays reachable — so a later retrieval can still return
 * a fact the user has explicitly retracted.
 *
 * Cycle-safe: a `supersedes` loop (A supersedes B supersedes A, possible through
 * a bad import) yields no closure for those nodes rather than looping.
 */
export function supersededBy(edges: readonly Edge[]): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>()
  for (const e of validEdges(edges)) {
    if (e.relation !== "supersedes") continue
    const bucket = direct.get(e.from)
    if (bucket === undefined) direct.set(e.from, new Set([e.to]))
    else bucket.add(e.to)
  }

  const closure = new Map<string, Set<string>>()
  for (const start of direct.keys()) {
    const seen = new Set<string>()
    const stack = [...(direct.get(start) ?? [])]
    while (stack.length > 0) {
      const node = stack.pop() as string
      if (node === start) continue // cycle guard
      if (seen.has(node)) continue
      seen.add(node)
      for (const next of direct.get(node) ?? []) stack.push(next)
    }
    closure.set(start, seen)
  }
  return closure
}

/**
 * Nodes that are dead: superseded, possibly through a chain.
 *
 * A node superseded by a node that is ITSELF superseded is still dead — the
 * newest version is the live one, and everything it transitively replaced is not.
 */
export function deadNodes(edges: readonly Edge[]): Set<string> {
  const closure = supersededBy(edges)
  const dead = new Set<string>()
  for (const targets of closure.values()) {
    for (const target of targets) dead.add(target)
  }
  return dead
}

/**
 * Every node that cannot proceed, because something it requires has failed or is
 * itself blocked.
 *
 * Propagation matters: without it a failing dependency produces work that runs,
 * fails somewhere less obvious, and reports a symptom rather than a cause.
 *
 * `blocked_by` and `requires` are both followed, because a caller may record
 * either and expecting one specific spelling is how propagation silently stops
 * working.
 */
export function propagateBlocked(
  edges: readonly Edge[],
  states: ReadonlyMap<string, NodeState>,
): Set<string> {
  const relevant = validEdges(edges).filter((e) => DEPENDENCY.has(e.relation))

  let blocked = new Set<string>()
  for (const [node, state] of states) {
    if (state === "failed" || state === "blocked") blocked.add(node)
  }

  // Grow to a fixed point rather than one pass: a chain A requires B requires C,
  // with C failed, needs two iterations to reach A.
  for (;;) {
    const next = new Set(blocked)
    for (const edge of relevant) {
      if (blocked.has(edge.to) && !blocked.has(edge.from)) next.add(edge.from)
    }
    if (next.size === blocked.size) break
    blocked = next
  }
  return blocked
}

/**
 * Contradiction pairs, normalised so each unordered pair appears once.
 *
 * `contradicts` is symmetric, so a query that returns both (A,B) and (B,A) makes
 * a count of "how many conflicts are there" wrong by a factor of two.
 */
export function contradictions(edges: readonly Edge[]): Array<[string, string]> {
  const seen = new Set<string>()
  const out: Array<[string, string]> = []
  for (const e of validEdges(edges)) {
    if (e.relation !== "contradicts") continue
    const key = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([e.from, e.to])
  }
  return out
}

/** True when the relation carries direction worth traversing. */
export function isDirected(relation: Relation): boolean {
  return DIRECTED.has(relation)
}

/**
 * Summarise a relation graph.
 *
 * `cycle` is reported as a path rather than a boolean, for the reason above. An
 * empty graph is healthy, not an error.
 */
export function summariseRelations(edges: readonly Edge[]): {
  nodes: number
  edges: number
  invalid: number
  cycle?: CycleWitness
  dead: number
  contradictions: number
} {
  const usable = validEdges(edges)
  return {
    nodes: nodesOf(usable).length,
    edges: usable.length,
    invalid: edges.length - usable.length,
    ...(findDependencyCycle(usable) === undefined ? {} : { cycle: findDependencyCycle(usable) }),
    dead: deadNodes(usable).size,
    contradictions: contradictions(usable).length,
  }
}
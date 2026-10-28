/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Collision-free ids for the timestamp-prefixed id scheme.
 *
 * A `Date.now()`-derived id is not an id: two plans, notebooks or posts
 * created inside the same millisecond got identical strings, and the
 * Map-keyed stores (plans, notebooks) silently overwrote the first one — the
 * second `create()` then returned data that had already replaced a plan the
 * caller still held. For plan steps it was subtler: two steps shared an id, so
 * `updateStep` patched whichever the scan found first.
 *
 * The time prefix is deliberately kept: ids stay sortable, human-readable, and
 * every already-persisted id keeps working (this never renames anything). Only
 * an actual collision adds a numeric suffix, checked against every id in hand —
 * including ids loaded from disk, so a fresh process cannot reissue a live one
 * either.
 */

/**
 * @param base  the id as it would be minted today (e.g. `plan-mcx1k2`)
 * @param taken every id that must not be reissued (live objects or disk state)
 */
export function uniqueId(base: string, taken: Iterable<string> = []): string {
  const used = taken instanceof Set ? taken : new Set(taken)
  if (!used.has(base)) return base

  let n = 2
  while (used.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

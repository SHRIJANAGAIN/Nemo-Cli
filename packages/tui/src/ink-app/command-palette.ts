/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { fuzzyMatchScore } from "./fuzzy.js"

/** One selectable palette row: an action (key chords) or a slash command. */
export interface PaletteEntry {
  id: string
  title: string
  description?: string
  category: string
  /** Keybinding hint rendered beside the title (SKT AI LABS's DialogSelect footer). */
  keybinding?: string
  /** Pinned into a "Suggested" section when the query is empty (SKT AI LABS). */
  suggested?: boolean
  run: () => void
}

/** A rendered row: suggested entries appear twice (pinned + in place), so
 * identity lives on rowId rather than on the entry itself. */
export interface PaletteRow {
  entry: PaletteEntry
  category: string
  rowId: string
}

/** SKT AI LABS DialogSelect scoring: the title outranks the description (title × 2). */
export function scorePaletteEntry(entry: PaletteEntry, query: string): number {
  return fuzzyMatchScore(entry.title, query) * 2 + (entry.description ? fuzzyMatchScore(entry.description, query) : 0)
}

/** Rank-filter entries against a query: matches only, best first. An empty
 * query passes the list through untouched (original order). */
export function filterPaletteEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim()
  if (!q) return entries
  return entries
    .map((entry) => ({ entry, score: scorePaletteEntry(entry, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry)
}

/** SKT AI LABS's CommandPalette list(): with an empty query, suggested entries are
 * pinned to the top under a "Suggested" category AND keep their normal slot;
 * while filtering, the pinning is dropped so results stay ranked. */
export function buildPaletteRows(entries: PaletteEntry[], query: string): PaletteRow[] {
  const filtered = filterPaletteEntries(entries, query)
  const base: PaletteRow[] = filtered.map((entry) => ({
    entry,
    category: entry.category,
    rowId: entry.id,
  }))
  if (query.trim()) return base
  const pinned: PaletteRow[] = filtered
    .filter((entry) => entry.suggested)
    .map((entry) => ({
      entry,
      category: "Suggested",
      rowId: `suggested:${entry.id}`,
    }))
  return [...pinned, ...base]
}

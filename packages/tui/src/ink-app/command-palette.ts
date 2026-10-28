/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { fuzzyMatchScore } from "./fuzzy.js"

/** One selectable palette row: an action (key chords) or a slash command. */
export interface PaletteEntry {
  id: string
  title: string
  description?: string
  category: string
  /** Keybinding hint rendered beside the title (Shrijan's DialogSelect footer). */
  keybinding?: string
  /** Pinned into a "Suggested" section when the query is empty (Shrijan). */
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

/** Shrijan DialogSelect scoring: the title outranks the description (title × 2). */
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

/** Shrijan's CommandPalette list(): with an empty query, suggested entries are
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

/** Minimal slash-command shape shared by the static list (types.ts) and the
 *  dispatch registry — name + description + category. */
export interface SlashRow {
  name: string
  description: string
  category?: string
}

/** Merge two slash-command sources append-only: every primary row keeps its
 *  place and order, secondary rows missing from primary are appended — so no
 *  chooser can hide the other side's commands (`/provider` never reached the
 *  palette, `/company` never reached `/help`). A name collision keeps the
 *  primary row; both surfaces dispatch through the same runSlash path, so the
 *  row always runs what its surface runs today. */
export function mergeSlashRows(primary: SlashRow[], secondary: SlashRow[]): SlashRow[] {
  const seen = new Set(primary.map((c) => c.name))
  return [...primary, ...secondary.filter((c) => !seen.has(c.name))]
}

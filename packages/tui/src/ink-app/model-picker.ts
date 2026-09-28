/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { fuzzyMatchScore } from "./fuzzy.js"

export interface ModelPickerRow {
  id: string
  /** "Favorites" | "Recent" | the provider's display name. */
  category: string
  /** Unique across sections (the same model can appear twice). */
  rowId: string
  isFavorite: boolean
  isCurrent: boolean
}

export interface BuildModelPickerRowsInput {
  /** Model ids offered by the provider (fetched from /v1/models). */
  models: readonly string[]
  favorites?: readonly string[]
  recents?: readonly string[]
  /** The active model — always surfaced and marked, even if the live
   * catalog no longer lists it. */
  current?: string
  /** Display name of the single backing provider (section header). */
  providerName?: string
  query?: string
}

/** Port of SKT AI LABS's buildModelPickerOptions for trayambak's single-provider
 * catalog:
 *  1. Favorites get their own pinned section and are deduped OUT of the
 *     provider list; recents are NOT — a used model stays visible under its
 *     provider (SKT AI LABS rule, so sections never look empty).
 *  2. The current model is forced into the provider list if missing.
 *  3. While filtering, ranking happens WITHIN each section so the
 *     Favorites → Recent → provider header order survives the query. */
export function buildModelPickerRows(input: BuildModelPickerRowsInput): ModelPickerRow[] {
  const favorites = input.favorites ?? []
  const recents = input.recents ?? []
  const current = input.current ?? ""
  const providerName = input.providerName ?? "provider"
  const query = (input.query ?? "").trim()

  const isFav = (id: string): boolean => favorites.includes(id)
  const known = new Set<string>([...input.models, current].filter((id) => id.length > 0))
  const row = (id: string, category: string): ModelPickerRow => ({
    id,
    category,
    rowId: `${category}:${id}`,
    isFavorite: isFav(id),
    isCurrent: id === current && id.length > 0,
  })

  const favoriteRows = favorites.filter((id) => known.has(id)).map((id) => row(id, "Favorites"))
  const recentRows = recents.filter((id) => !isFav(id) && known.has(id)).map((id) => row(id, "Recent"))

  const providerIds = [...input.models]
  if (current && !providerIds.includes(current)) providerIds.push(current)
  const providerRows = providerIds.filter((id) => !isFav(id)).map((id) => row(id, providerName))

  const sections: ModelPickerRow[][] = [favoriteRows, recentRows, providerRows]
  if (!query) return sections.flat()

  const ranked = sections.map((rows) =>
    rows
      .map((r) => ({
        r,
        score:
          fuzzyMatchScore(r.id, query) * 2 + fuzzyMatchScore(r.category, query) + fuzzyMatchScore(providerName, query),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.r),
  )
  return ranked.flat()
}

/** Toggle an id in the favorites list (SKT AI LABS's local.model.toggleFavorite). */
export function toggleFavorite(favorites: readonly string[], id: string): string[] {
  return favorites.includes(id) ? favorites.filter((entry) => entry !== id) : [id, ...favorites]
}

/** Move an id to the front of recents, deduped and capped (SKT AI LABS marks
 * `recent: true` on every model set). */
export function pushRecent(recents: readonly string[], id: string, max = 20): string[] {
  return [id, ...recents.filter((entry) => entry !== id)].slice(0, max)
}

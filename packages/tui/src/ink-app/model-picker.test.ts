/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { buildModelPickerRows, pushRecent, toggleFavorite } from "./model-picker.js"

describe("buildModelPickerRows", () => {
  it("orders sections Favorites → Recent → provider", () => {
    const rows = buildModelPickerRows({
      models: ["a", "b"],
      favorites: ["b"],
      recents: ["a"],
      providerName: "NVIDIA NIM",
    })
    expect(rows.map((r) => r.rowId)).toEqual([
      "Favorites:b",
      "Recent:a",
      "NVIDIA NIM:a", // favorite "b" is deduped out of the provider section
    ])
  })

  it("dedupes favorites out of the provider list but keeps recents there (Shrijan rule)", () => {
    const rows = buildModelPickerRows({
      models: ["a", "b"],
      favorites: ["a"],
      recents: ["b"],
      providerName: "p",
    })
    const providerIds = rows.filter((r) => r.category === "p").map((r) => r.id)
    expect(providerIds).toEqual(["b"]) // favorite "a" only under Favorites
    expect(rows.filter((r) => r.category === "Recent").map((r) => r.id)).toEqual(["b"])
    expect(rows.some((r) => r.rowId === "p:b")).toBe(true) // recent still in provider list
  })

  it("forces the current model into the provider list when the catalog omits it", () => {
    const rows = buildModelPickerRows({
      models: ["a"],
      current: "custom/current-model",
      providerName: "p",
    })
    expect(rows.map((r) => r.id)).toContain("custom/current-model")
    expect(rows.find((r) => r.id === "custom/current-model")?.isCurrent).toBe(true)
  })

  it("drops favorites that resolve to nothing", () => {
    const rows = buildModelPickerRows({
      models: ["a"],
      favorites: ["ghost"],
      providerName: "p",
    })
    expect(rows.some((r) => r.id === "ghost")).toBe(false)
  })

  it("keeps provider order for an empty query", () => {
    const rows = buildModelPickerRows({
      models: ["z", "m", "a"],
      providerName: "p",
    })
    expect(rows.map((r) => r.id)).toEqual(["z", "m", "a"])
  })

  it("ranks within each section so section headers survive filtering", () => {
    const rows = buildModelPickerRows({
      models: ["zzz-alpha", "alpha-fav"], // favorites must come from the catalog
      favorites: ["alpha-fav"],
      providerName: "p",
      query: "alpha",
    })
    expect(rows[0]?.category).toBe("Favorites")
    expect(rows[0]?.id).toBe("alpha-fav")
    expect(rows.map((r) => r.category)).toContain("p")
  })
})

describe("toggleFavorite", () => {
  it("adds then removes", () => {
    let list = toggleFavorite([], "a")
    expect(list).toEqual(["a"])
    list = toggleFavorite(list, "a")
    expect(list).toEqual([])
  })

  it("pins new favorites to the front", () => {
    expect(toggleFavorite(["a"], "b")).toEqual(["b", "a"])
  })
})

describe("pushRecent", () => {
  it("moves an existing id to the front without duplicating", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"])
  })

  it("caps the list length", () => {
    const list = pushRecent(["1", "2", "3"], "new", 3)
    expect(list).toEqual(["new", "1", "2"])
  })
})

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Stateless provider/model support helpers for the app shell.
 *
 * Extracted from App.tsx for the max-file-size rule (the shell was 4061
 * lines against a 4000 cap). Every function here closes over module imports
 * only — never component state, props or refs — so hoisting them to module
 * scope is behavior-identical: they were recreated per render before and are
 * pure now. Nothing in App.tsx may reintroduce a closure over render scope
 * here; that would silently break the extraction's equivalence.
 */

import { rgbToHex } from "./themeColors.js"
import { g } from "./glyphs.js"
import { getCatalogEntry } from "../../../provider/src/catalog.js"
import { loadConfig, saveConfig, cleanApiKey } from "../../../../apps/runtime/src/config.js"
import type { Theme as NemoTheme } from "../ui/theme.js"

/** Theme → option row for the theme picker (humanized name + dark/light + swatch). */
export function themeToPickerOption(theme: NemoTheme) {
  return {
    name: theme.name,
    label: theme.name
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    description: theme.dark ? "dark" : "light",
    swatch: rgbToHex(theme.primary),
  }
}

/** Provider display info for the model picker (refreshes on /login + /provider use). */
export function providerLabelFor(id: string): string {
  return (
    getCatalogEntry(id)?.label ??
    (
      {
        llamacpp: "llama.cpp",
        nvidia: "NVIDIA",
        "nvidia-nim": "NVIDIA NIM",
        ollama: "Ollama",
        custom: "Custom endpoint",
      } as Record<string, string>
    )[id] ??
    "NVIDIA NIM"
  )
}

/** Host for display in the picker. Unparseable input comes back unchanged —
 *  and so does scheme-less input like "localhost:8080", which `new URL`
 *  happily parses as protocol "localhost:" with an EMPTY host (the old code
 *  showed a blank provider instead of the host the user typed). */
export function providerHostFor(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host
    return host === "" ? baseUrl : host
  } catch {
    return baseUrl
  }
}

/** Honest fetch suffix: silent fallbacks made stale lists look live. */
export function fetchWarn(error?: string): string {
  if (error === "auth") return ` — ${g("warn")} endpoint rejected the key (401); run /provider key with a fresh key`
  if (error === "network") return ` — ${g("warn")} endpoint unreachable`
  return ""
}

/** Cached live list for a backend (persisted on every successful fetch). */
export function cachedModels(providerId: string): string[] {
  const c = loadConfig().modelCache?.[providerId.toLowerCase()]
  return Array.isArray(c) ? c.filter((m): m is string => typeof m === "string" && m.length > 0) : []
}

export function rememberModels(providerId: string, models: string[]): void {
  if (models.length === 0) return
  try {
    saveConfig({
      modelCache: { ...(loadConfig().modelCache ?? {}), [providerId.toLowerCase()]: models.slice(0, 150) },
    })
  } catch {
    /* cache must never break the flow */
  }
}

/** live → cached-live → empty: never pad with the catalog's tiny static
 *  list — a stale 5-row fallback masquerading as the full catalog was the
 *  "why do I only see 5 models?" bug. Empty lets the picker say "No models
 *  reported by this provider." honestly. Tag drives the one-line status. */
export function resolveModels(
  providerId: string,
  res: { models: string[]; source: "live" | "fallback"; error?: string },
): { models: string[]; tag: string } {
  if (res.models.length > 0 && res.source === "live") {
    rememberModels(providerId, res.models)
    return { models: res.models, tag: "live" }
  }
  const cached = cachedModels(providerId)
  if (cached.length > 0) return { models: cached, tag: `cached (${cached.length})${fetchWarn(res.error)}` }
  return { models: [], tag: `no list${fetchWarn(res.error)}` }
}

/** Per-backend key memory (config `providers[]`): switching backends must
 *  not wipe saved keys — without this every switch reset the old backend
 *  to keyless and the next turn 401d. Values are never printed. */
export function readStoredKey(providerId: string): { apiKey: string; baseUrl: string } {
  const found = loadConfig().providers?.find((p) => p.id === providerId || p.type === providerId)
  return { apiKey: found?.apiKey ?? "", baseUrl: found?.baseUrl ?? "" }
}

export function writeStoredKey(providerId: string, apiKey: string, baseUrl: string): void {
  const cfg = loadConfig()
  const entry = getCatalogEntry(providerId)
  const arr = [...(cfg.providers ?? [])]
  const norm = providerId.toLowerCase()
  const idx = arr.findIndex((p) => (p.id ?? "").toLowerCase() === norm || (p.type ?? "").toLowerCase() === norm)
  const row = {
    id: providerId,
    type: providerId,
    label: entry?.label ?? providerId,
    baseUrl,
    apiKey: cleanApiKey(apiKey),
  }
  if (idx >= 0) arr[idx] = { ...arr[idx], ...row }
  else arr.push(row)
  saveConfig({ providers: arr.slice(0, 20) })
}

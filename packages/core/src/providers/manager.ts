/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Provider } from "../../../../packages/provider/src/types.js"
import type { ProviderEntry, ProviderRegistry } from "./registry.js"
import { createProviderRegistry } from "./registry.js"
import * as http from "http"
import * as https from "https"
import * as url from "url"

export interface ProviderManagerConfig {
  providers: ProviderEntry[]
  activeProviderId?: string
}

export class ProviderManager {
  private readonly registry: ProviderRegistry
  private readonly entries = new Map<string, ProviderEntry>()
  private activeProvider: Provider | null = null
  private activeEntry: ProviderEntry | null = null

  constructor(config: ProviderManagerConfig = { providers: [] }) {
    this.registry = createProviderRegistry()
    for (const entry of config.providers) {
      this.entries.set(entry.id, entry)
    }
    if (config.activeProviderId) {
      this.activate(config.activeProviderId)
    }
  }

  add(entry: ProviderEntry): void {
    this.entries.set(entry.id, entry)
  }

  remove(id: string): boolean {
    const removed = this.entries.delete(id)
    if (this.activeEntry?.id === id) {
      this.activeProvider = null
      this.activeEntry = null
    }
    return removed
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.get(id)
  }

  list(): ProviderEntry[] {
    return Array.from(this.entries.values())
  }

  active(): ProviderEntry | undefined {
    return this.activeEntry ?? this.entries.values().next().value
  }

  activate(id: string): Provider | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const provider = this.registry.create(entry.type, {
      baseUrl: entry.baseUrl,
      model: entry.model ?? "default",
      apiKey: entry.apiKey,
      temperature: entry.temperature,
      topP: entry.topP,
      maxTokens: entry.maxTokens,
      timeoutMs: entry.timeoutMs,
      reasoningEffort: entry.reasoningEffort,
      label: entry.label,
      chatTemplateKwargs: entry.chatTemplateKwargs,
    })
    if (provider) {
      this.activeProvider = provider
      this.activeEntry = entry
    }
    return provider ?? null
  }

  getActiveProvider(): Provider | null {
    return this.activeProvider
  }

  getActiveEntry(): ProviderEntry | null {
    return this.activeEntry
  }

  async fetchModels(id: string): Promise<string[]> {
    const entry = this.entries.get(id)
    if (!entry) return []
    return listModelNames(entry.baseUrl, entry.apiKey ?? "")
  }

  supportedTypes(): string[] {
    return this.registry.types()
  }

  hasType(type: string): boolean {
    return this.registry.has(type)
  }
}

export function listModelNames(baseUrl: string, apiKey: string): Promise<string[]> {
  const endpoint = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models"
  const parsed = new url.URL(endpoint)
  const lib = parsed.protocol === "https:" ? https : http

  return new Promise((resolve, reject) => {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error(`Invalid URL protocol: ${parsed.protocol}`))
      return
    }
    const req = lib.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        timeout: 4000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      },
      (res) => {
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (buf += c))
        res.on("end", () => {
          try {
            const json = JSON.parse(buf) as { data?: Array<{ id?: string }> }
            const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string")
            if (ids.length > 0) {
              resolve(ids)
              return
            }
          } catch {
            // fall through to empty fallback
          }
          resolve([])
        })
      },
    )
    req.on("error", () => resolve([]))
    req.on("timeout", () => {
      req.destroy()
      resolve([])
    })
  })
}

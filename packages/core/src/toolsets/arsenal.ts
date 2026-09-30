/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../protocol/src/index.js"
import type { ArsenalConfig, ToolsetDefinition } from "../../../protocol/src/toolsets.js"
import { DEFAULT_ARSENAL_CONFIG } from "../../../protocol/src/toolsets.js"

type CheckCache = Map<string, { value: boolean; ts: number }>

const CHECK_TTL_MS = 60_000

export interface ToolLike {
  definition: ToolDefinition
}

export class Arsenal<T extends ToolLike = ToolLike> {
  private readonly tools: Map<string, T> = new Map()
  private readonly toolsets: Map<string, ToolsetDefinition> = new Map()
  private readonly checkCache: CheckCache = new Map()
  private readonly disabled: Set<string> = new Set()
  private readonly platform: string
  private coreTools: string[] = []

  constructor(config: ArsenalConfig = DEFAULT_ARSENAL_CONFIG, platform = "default") {
    this.platform = platform
    this.disabled = new Set(config.disabledToolsets)
    this.coreTools = config.defaultToolsets
  }

  registerTool(tool: T): void {
    this.tools.set(tool.definition.name, tool)
  }

  registerToolset(def: ToolsetDefinition): void {
    this.toolsets.set(def.name, def)
  }

  setCoreTools(names: string[]): void {
    this.coreTools = names
  }

  resolveTools(available: T[]): T[] {
    const availableSet = new Set(available.map((t) => t.definition.name))
    const selected = new Set<string>()

    for (const toolsetName of this.coreTools) {
      if (this.disabled.has(toolsetName)) continue
      const def = this.toolsets.get(toolsetName)
      if (!def) continue
      if (def.checkFn && !this.evaluateCheck(def.checkFn, toolsetName)) continue
      for (const name of def.toolNames) {
        if (availableSet.has(name)) selected.add(name)
      }
    }

    const byName = new Map(available.map((t) => [t.definition.name, t]))
    return Array.from(selected)
      .map((name) => byName.get(name)!)
      .filter(Boolean)
  }

  resolveToolNames(available: string[]): string[] {
    const availableSet = new Set(available)
    const selected = new Set<string>()

    for (const toolsetName of this.coreTools) {
      if (this.disabled.has(toolsetName)) continue
      const def = this.toolsets.get(toolsetName)
      if (!def) continue
      if (def.checkFn && !this.evaluateCheck(def.checkFn, toolsetName)) continue
      for (const name of def.toolNames) {
        if (availableSet.has(name)) selected.add(name)
      }
    }

    return Array.from(selected)
  }

  toolsetNames(): string[] {
    return Array.from(this.toolsets.keys())
  }

  toolsetDefinition(name: string): ToolsetDefinition | undefined {
    return this.toolsets.get(name)
  }

  private evaluateCheck(fn: ToolsetDefinition["checkFn"], toolsetName: string): boolean {
    const cached = this.checkCache.get(toolsetName)
    if (cached && Date.now() - cached.ts < CHECK_TTL_MS) return cached.value

    let result = false
    try {
      const value = fn?.()
      result = value instanceof Promise ? false : Boolean(value)
    } catch {
      result = false
    }

    this.checkCache.set(toolsetName, { value: result, ts: Date.now() })
    return result
  }
}

export function buildArsenal<T extends ToolLike>(
  tools: T[],
  config: ArsenalConfig = DEFAULT_ARSENAL_CONFIG,
  platform = "default",
): Arsenal<T> {
  const arsenal = new Arsenal<T>(config, platform)
  for (const tool of tools) arsenal.registerTool(tool)
  return arsenal
}

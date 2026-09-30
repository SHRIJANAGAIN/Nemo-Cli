/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { Tool, ToolDefinition } from "../../../apps/runtime/src/index.js"

/** A registry over the available functions/tools exposed to the model. */
export class FunctionRegistry {
  private readonly byName = new Map<string, Tool>()

  register(tool: Tool): void {
    this.byName.set(tool.definition.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t)
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name)
  }

  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((t) => t.definition)
  }

  names(): string[] {
    return [...this.byName.keys()]
  }
}

export function createFunctionRegistry(tools: Tool[]): FunctionRegistry {
  const registry = new FunctionRegistry()
  registry.registerAll(tools)
  return registry
}

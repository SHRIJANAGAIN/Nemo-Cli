/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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

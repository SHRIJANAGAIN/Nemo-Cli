/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool, ToolContext } from "../tools/index.js"
import type { NemoConfig } from "../config.js"
import type { Provider } from "../../../../packages/provider/src/index.js"
import type { Session } from "../session/session.js"
import type { DeveloperModeEngine } from "../developer-mode/index.js"
import type { RoleContext } from "./state.js"
import { DEFAULT_PERMISSIONS } from "../../../../packages/protocol/src/permissions.js"
import { evaluatePermission } from "../../../../packages/protocol/src/permission-rules.js"

export interface ExecutorConfig {
  provider: Provider
  tools: Tool[]
  session: Session
  developerMode?: DeveloperModeEngine
  signal?: AbortSignal
}

export interface ExecutionResult {
  success: boolean
  output: string
  error?: string
  artifacts?: string[]
}

export class Executor {
  private readonly config: ExecutorConfig

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  async executePlanStep(stepDescription: string, context: RoleContext): Promise<ExecutionResult> {
    const toolCalls = this.buildToolCalls(stepDescription, context)
    const results: string[] = []
    const artifacts: string[] = []

    for (const toolCall of toolCalls) {
      const result = await this.executeToolCall(toolCall)
      results.push(result.output)
      if (result.error) {
        return { success: false, output: results.join("\n"), error: result.error, artifacts }
      }
      if (result.artifacts) {
        artifacts.push(...result.artifacts)
      }
    }

    return { success: true, output: results.join("\n"), artifacts }
  }

  async executeFix(errorMessage: string, context: RoleContext): Promise<ExecutionResult> {
    const fixPrompt = `Fix the following error:\n${errorMessage}\n\nContext:\n${JSON.stringify(context, null, 2)}`
    return this.executePlanStep(fixPrompt, context)
  }

  private buildToolCalls(
    description: string,
    _context: RoleContext,
  ): Array<{ name: string; arguments: Record<string, unknown> }> {
    return [{ name: "write_file", arguments: { path: "scratchpad.txt", content: description } }]
  }

  private async executeToolCall(toolCall: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<ExecutionResult> {
    const tool = this.config.tools.find((t) => t.definition.name === toolCall.name)
    if (!tool) {
      return { success: false, output: "", error: `Unknown tool: ${toolCall.name}` }
    }

    // Hard permission gate for direct (non-loop) tool execution: a deny
    // rule vetoes outright. "ask" decisions pass — this path runs internal
    // scratchpad writes with no human attached, and the interactive agent
    // loop is the path that prompts for approval.
    const decision = evaluatePermission(toolCall.name, toolCall.arguments, DEFAULT_PERMISSIONS)
    if (decision.action === "deny") {
      const why = decision.rule ? `${decision.rule.tool} → ${decision.rule.pattern ?? "*"}` : decision.source
      return { success: false, output: "", error: `Permission denied for ${toolCall.name}: ${why}` }
    }

    const first = this.config.session.messages[0]?.content[0]
    const context: ToolContext = {
      cwd: (typeof first === "string" ? first : first && "text" in first ? first.text : undefined) ?? ".",
      // This controller has no provider config in scope; tools only read
      // optional fields off it (maxOutputLines/maxOutputBytes), so an empty
      // object is the deliberate "no overrides" value here.
      config: {} as NemoConfig,
      permissions: DEFAULT_PERMISSIONS,
    }

    try {
      const result = await tool.execute(toolCall.name, toolCall.arguments, this.config.signal, undefined, context)
      const output = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
      return { success: !result.isError, output, error: result.isError ? output : undefined }
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) }
    }
  }
}

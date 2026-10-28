/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  coerceToolArguments,
  validateToolArguments,
  formatValidationIssues,
  normalizeSchema,
} from "../../../../packages/core/src/tool_schema.js"
import type { Tool } from "./types.js"

/**
 * Wrap a tool so its arguments are checked against the schema it already
 * declares, before the tool body runs.
 *
 * Why this matters: every tool already publishes `parameters.properties` and
 * `required` to the model so the model knows what to emit, but nothing checked
 * the reply. A model that sent `{"path": 42}` for a string parameter got the
 * failure from deep inside the tool — a `path.resolve` that produced
 * `.../undefined`, or an ENOENT naming a file that never existed. The model then
 * read "no such file" and tried a different path, because from its side the
 * diagnosis was a missing file rather than a wrong argument type. The turn was
 * lost, and the transcript recorded something untrue.
 *
 * Checking at the boundary produces a message the model can act on in one step:
 * which field, what type was expected, what actually arrived.
 *
 * The failure is returned as an `isError` tool result rather than thrown. Tools
 * report problems in their result content, and the loop renders those as a
 * transcript row the model reads on its next turn — which is the only way it can
 * correct itself. Throwing would surface as an agent-level failure and end the
 * turn before the model ever saw the complaint.
 */
export function validateArguments(tool: Tool): Tool {
  const definition = tool.definition
  const schema = normalizeSchema(definition.parameters)

  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate, context) => {
      const coerced = coerceToolArguments(schema, args)
      const result = validateToolArguments(schema, coerced)
      if (result.valid) return tool.execute(toolCallId, coerced as Record<string, unknown>, signal, onUpdate, context)

      const message = formatValidationIssues(result.issues)
      return {
        content: [
          {
            type: "text" as const,
            // Named first so the model knows WHICH tool rejected the call — the
            // same message text from a different tool would be ambiguous when
            // several ran in one parallel batch.
            text: `${definition.name} rejected the call. ${message}`,
          },
        ],
        isError: true,
      }
    },
  }
}

/**
 * Find tools whose declared schema disagrees with itself.
 *
 * This is a lint for schemas rather than for values, and it catches the two
 * mistakes that make a schema actively mislead the model:
 *
 *  - a `required` key with no matching entry in `properties`, so the model is
 *    told to send a field it was never given a description or type for;
 *  - an `array` property with no `items`, so nothing states what the array holds.
 *
 * Both pass validation at runtime forever while making the tool harder to call
 * correctly, which is why they are worth failing a test over.
 */
export function auditToolSchemas(tools: readonly Tool[]): Array<{ tool: string; problem: string }> {
  const problems: Array<{ tool: string; problem: string }> = []
  for (const tool of tools) {
    const name = tool.definition.name
    const parameters = tool.definition.parameters
    if (parameters === null || typeof parameters !== "object") {
      problems.push({ tool: name, problem: "parameters is not an object" })
      continue
    }
    const properties = parameters.properties
    for (const required of parameters.required) {
      if (properties === null || typeof properties !== "object" || !(required in properties)) {
        problems.push({ tool: name, problem: `required "${required}" has no property definition` })
      }
    }
    for (const [key, property] of Object.entries(properties ?? {})) {
      if (property === null || typeof property !== "object") continue
      if (property.type === "array" && property.items === undefined) {
        problems.push({ tool: name, problem: `array property "${key}" declares no items schema` })
      }
      if (
        property.enum !== undefined &&
        (!Array.isArray(property.enum) || property.enum.length === 0)
      ) {
        problems.push({ tool: name, problem: `property "${key}" has an empty or invalid enum` })
      }
    }
  }
  return problems
}
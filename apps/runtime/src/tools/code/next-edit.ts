/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "next_edit",
  description:
    "Next-edit suggestion: given the code before (prefix) and after (suffix) the cursor, predict the next edit via the active provider's FIM endpoint. Read-only suggestion — never applies anything. Honest error when the provider has no FIM endpoint.",
  parameters: {
    type: "object",
    required: ["prefix"],
    properties: {
      prefix: { type: "string", description: "Code before the cursor." },
      suffix: { type: "string", description: "Code after the cursor." },
      hint: { type: "string", description: "Optional intent hint, e.g. 'close the loop'." },
      max_tokens: { type: "number", description: "Maximum suggestion tokens. Default 128, max 1024." },
      temperature: { type: "number", description: "Sampling temperature. Default 0.2." },
    },
  },
}

const MAX_PREFIX_CHARS = 4000
const MAX_SUFFIX_CHARS = 2000
const MAX_OUTPUT_CHARS = 2000

/** Build a bounded FIM prompt with an optional intent hint. Pure. */
export function buildNextEditPrompt(prefix: string, suffix: string, hint?: string): { prompt: string; suffix: string } {
  const tail = prefix.length > MAX_PREFIX_CHARS ? prefix.slice(-MAX_PREFIX_CHARS) : prefix
  const head = suffix.length > MAX_SUFFIX_CHARS ? suffix.slice(0, MAX_SUFFIX_CHARS) : suffix
  const cleanHint = (hint ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  const prompt = cleanHint.length > 0 ? `${tail}\n// next edit: ${cleanHint}\n` : tail
  return { prompt, suffix: head }
}

/** `next_edit` tool: single-suggestion FIM through the agent's live provider. */
export function createNextEditTool(getProvider?: () => Provider | undefined): Tool {
  return {
    definition,
    async execute(_id, args, signal) {
      const prefix = String(args.prefix ?? "")
      if (!prefix.trim()) return textResult("Missing required parameter: prefix", /*isError*/ true)
      const provider = getProvider?.()
      if (!provider) return textResult("No provider available for next-edit.", /*isError*/ true)
      if (!provider.fim) return textResult(`Provider '${provider.id}' has no FIM endpoint.`, /*isError*/ true)
      const maxTokens =
        typeof args.max_tokens === "number" && Number.isFinite(args.max_tokens)
          ? Math.max(1, Math.min(1024, Math.floor(args.max_tokens)))
          : 128
      const temperature =
        typeof args.temperature === "number" && Number.isFinite(args.temperature)
          ? Math.max(0, Math.min(2, args.temperature))
          : 0.2
      const hint = typeof args.hint === "string" ? args.hint : undefined
      const suffix = typeof args.suffix === "string" ? args.suffix : ""
      const built = buildNextEditPrompt(prefix, suffix, hint)
      try {
        const result = await provider.fim({
          prompt: built.prompt,
          suffix: built.suffix.length > 0 ? built.suffix : undefined,
          maxTokens,
          temperature,
          signal,
        })
        const text = result.text.trim().slice(0, MAX_OUTPUT_CHARS)
        return textResult(text.length > 0 ? text : "(empty suggestion)")
      } catch (error) {
        return textResult(
          `next-edit failed: ${error instanceof Error ? error.message : String(error)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

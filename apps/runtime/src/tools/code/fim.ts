/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "fim",
  description:
    "Fill-in-the-middle code completion: given the code before (prefix) and after (suffix) the cursor, return the middle. Uses the active provider's completions endpoint. Best for single-shot insertions the model drafts from surrounding code.",
  parameters: {
    type: "object",
    required: ["prefix"],
    properties: {
      prefix: { type: "string", description: "Code before the cursor." },
      suffix: { type: "string", description: "Code after the cursor." },
      max_tokens: { type: "number", description: "Maximum completion tokens. Default 256." },
      temperature: { type: "number", description: "Sampling temperature. Default 0.2." },
    },
  },
}

/** `fim` tool: prefix/suffix completion through the agent's live provider. */
export function createFimTool(getProvider?: () => Provider | undefined): Tool {
  return {
    definition,
    async execute(_id, args, signal) {
      const prefix = String(args.prefix ?? "")
      if (!prefix.trim()) return textResult("Missing required parameter: prefix", /*isError*/ true)
      const provider = getProvider?.()
      if (!provider) return textResult("No provider available for FIM.", /*isError*/ true)
      if (!provider.fim) return textResult(`Provider '${provider.id}' has no FIM endpoint.`, /*isError*/ true)
      const maxTokens =
        typeof args.max_tokens === "number" && Number.isFinite(args.max_tokens)
          ? Math.max(1, Math.min(4096, Math.floor(args.max_tokens)))
          : 256
      const temperature =
        typeof args.temperature === "number" && Number.isFinite(args.temperature)
          ? Math.max(0, Math.min(2, args.temperature))
          : 0.2
      try {
        const result = await provider.fim({
          prompt: prefix,
          suffix: typeof args.suffix === "string" ? args.suffix : undefined,
          maxTokens,
          temperature,
          signal,
        })
        return textResult(result.text)
      } catch (error) {
        return textResult(`FIM failed: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__AskUserQuestion",
  description:
    "Ask the user a structured question with multiple-choice options. Use when you need clarification or a decision from the user.",
  parameters: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        description:
          "List of questions to ask the user. Each item is an object with question, header, options, and multi_select fields.",
        items: {
          type: "object",
          description:
            "A question object with question (string), header (string), options (array of {label, description}), and multi_select (boolean).",
        },
      },
    },
  },
}

export function createAskUserQuestionTool(
  onAsk?: (
    questions: Array<{
      question: string
      header?: string
      options: Array<{ label: string; description?: string }>
      multi_select: boolean
    }>,
  ) => Promise<string[]>,
): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, _context) {
      const raw = args.questions ?? []
      const questions = Array.isArray(raw) ? raw : []
      const normalized = questions.map((q) => {
        const record = typeof q === "object" && q !== null ? q : {}
        const question = typeof record.question === "string" ? record.question : ""
        const optionsRaw = Array.isArray(record.options) ? record.options : []
        const options = optionsRaw.map((o: { label?: unknown; description?: unknown }) => {
          const entry = typeof o === "object" && o !== null ? o : {}
          return {
            label: typeof entry.label === "string" ? entry.label : String(entry ?? ""),
            description: typeof entry.description === "string" ? entry.description : "",
          }
        })
        return { question, options, multi_select: !!record.multi_select }
      })
      if (normalized.length === 0) return textResult("Missing 'questions'.", /*isError*/ true)
      if (onAsk) {
        const answers = await onAsk(normalized)
        const out = normalized.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(skipped)"}`).join("\n\n")
        return textResult(out)
      }
      const out = normalized
        .map((q) => `Q: ${q.question}\nOptions: ${q.options.map((o: { label: string }) => o.label).join(", ")}`)
        .join("\n\n")
      return textResult(`[awaiting user input]\n\n${out}`)
    },
  }
}

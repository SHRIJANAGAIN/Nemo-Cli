/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__AskUserQuestion",
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

/** Fan-out bounds: one AskUserQuestion call must not flood the prompt with an
 *  unbounded question/option matrix or megabyte-long labels (#116). */
const MAX_QUESTIONS = 10
const MAX_OPTIONS = 10
const MAX_QUESTION_CHARS = 500
const MAX_HEADER_CHARS = 80
const MAX_LABEL_CHARS = 200
const MAX_DESC_CHARS = 300

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)

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
      const source = Array.isArray(raw) ? raw : []
      const questions = source.slice(0, MAX_QUESTIONS)
      let optionsTruncated = false
      const normalized = questions.map((q) => {
        const record = typeof q === "object" && q !== null ? q : {}
        const question = typeof record.question === "string" ? clip(record.question, MAX_QUESTION_CHARS) : ""
        const header = typeof record.header === "string" ? clip(record.header, MAX_HEADER_CHARS) : ""
        const optionsRaw = Array.isArray(record.options) ? record.options : []
        if (optionsRaw.length > MAX_OPTIONS) optionsTruncated = true
        const options = optionsRaw.slice(0, MAX_OPTIONS).map((o: { label?: unknown; description?: unknown }) => {
          const entry = typeof o === "object" && o !== null ? o : {}
          return {
            label: clip(typeof entry.label === "string" ? entry.label : String(entry.label ?? ""), MAX_LABEL_CHARS),
            description: clip(typeof entry.description === "string" ? entry.description : "", MAX_DESC_CHARS),
          }
        })
        return { question, header, options, multi_select: !!record.multi_select }
      })
      if (normalized.length === 0) return textResult("Missing 'questions'.", /*isError*/ true)
      const notes: string[] = []
      if (source.length > MAX_QUESTIONS) notes.push(`question limit: showing ${MAX_QUESTIONS} of ${source.length}`)
      if (optionsTruncated) notes.push(`options capped at ${MAX_OPTIONS} per question`)
      const note = notes.length > 0 ? `\n\n(${notes.join("; ")})` : ""
      if (onAsk) {
        const answers = await onAsk(normalized)
        const out = normalized.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? "(skipped)"}`).join("\n\n")
        return textResult(out + note)
      }
      const out = normalized
        .map((q) => `Q: ${q.question}\nOptions: ${q.options.map((o: { label: string }) => o.label).join(", ")}`)
        .join("\n\n")
      return textResult(`[awaiting user input]\n\n${out}${note}`)
    },
  }
}

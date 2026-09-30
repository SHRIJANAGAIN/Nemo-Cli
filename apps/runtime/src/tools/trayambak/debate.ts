/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"
import type { TeamTask } from "./team.js"

export const DEBATE_MIN_TEAMS = 2
export const DEBATE_MAX_TEAMS = 5

/** Split hypotheses across file boundaries so teammates never edit the same files. */
export function buildDebateTasks(
  topic: string,
  hypotheses: string[],
  opts?: { files?: string[][]; round?: number },
): TeamTask[] {
  const teams = hypotheses.slice(0, DEBATE_MAX_TEAMS)
  return teams.map((hypothesis, i) => {
    const files = opts?.files?.[i] ?? []
    const others = teams.filter((_, j) => j !== i)
    return {
      name: `debate-teammate-${i + 1}`,
      prompt:
        `You are teammate ${i + 1} of ${teams.length} in a Trayambak Council scientific debate.\n` +
        `Topic: ${topic}\n` +
        `Your hypothesis: ${hypothesis}\n` +
        (files.length > 0 ? `Your files (do not touch teammates' files): ${files.join(", ")}\n` : "") +
        `Opposing hypotheses to disprove:\n${others.map((o, k) => `${k + 1}. ${o}`).join("\n")}\n` +
        `Rules: gather evidence with tools, message teammates via trayambak__SendMessage to challenge their theories, ` +
        `concede explicitly if your hypothesis is disproven, and end with a verdict: SUPPORTED, DISPROVEN, or UNRESOLVED + evidence.`,
      subagentType: "debate-teammate",
    }
  })
}

/** Synthesize teammate verdicts into a consensus report. Pure. */
export function synthesizeDebate(
  topic: string,
  results: Array<{ name: string; text?: string; error?: string }>,
): string {
  const lines = results.map((r) =>
    r.error ? `### ${r.name}\nERROR: ${r.error}` : `### ${r.name}\n${(r.text ?? "").trim().slice(0, 2000)}`,
  )
  return (
    `## Council debate: ${topic}\n` +
    `Teammates heard: ${results.length}. Each theory was argued against the others; ` +
    `only verdicts with surviving evidence count as consensus.\n\n${lines.join("\n\n")}`
  )
}

const definition: ToolDefinition = {
  timeoutMs: 120_000,
  name: "trayambak__Debate",
  description:
    "Run a Trayambak Council scientific debate: 2-5 teammates each argue a competing hypothesis, challenge each other via messages, and report verdicts. Best for debugging with rival theories or reviews needing independent lenses.",
  parameters: {
    type: "object",
    required: ["topic", "hypotheses"],
    properties: {
      topic: { type: "string", description: "The question or problem under debate." },
      hypotheses: {
        type: "array",
        items: { type: "string", description: "One competing hypothesis." },
        description: "2-5 rival hypotheses, one per teammate.",
      },
    },
  },
}

export function createDebateTool(
  onRunTeam?: (
    tasks: TeamTask[],
  ) => Promise<Array<{ name: string; text: string; error?: string; background?: boolean; subagentId?: string }>>,
): Tool {
  return {
    definition,
    async execute(_id, args) {
      if (!onRunTeam) return textResult("Team runner is unavailable.", /*isError*/ true)
      const topic = String(args.topic ?? "").trim()
      const raw = args.hypotheses
      if (!topic) return textResult("Missing 'topic'.", /*isError*/ true)
      if (!Array.isArray(raw) || raw.length < DEBATE_MIN_TEAMS)
        return textResult(`Provide ${DEBATE_MIN_TEAMS}-${DEBATE_MAX_TEAMS} hypotheses.`, /*isError*/ true)
      const hypotheses = raw
        .map((h) => String(h ?? "").trim())
        .filter((h) => h.length > 0)
        .slice(0, DEBATE_MAX_TEAMS)
      if (hypotheses.length < DEBATE_MIN_TEAMS)
        return textResult(`Provide ${DEBATE_MIN_TEAMS}-${DEBATE_MAX_TEAMS} hypotheses.`, /*isError*/ true)
      const tasks = buildDebateTasks(topic, hypotheses)
      const results = await onRunTeam(tasks)
      return textResult(synthesizeDebate(topic, results))
    },
  }
}

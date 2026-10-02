/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"
import type { TeamTask } from "./team.js"

export const SWARM_MAX_WORKERS = 8
export const SWARM_MIN_VOTERS = 2
export const SWARM_MAX_VOTERS = 7
export const SWARM_DEFAULT_CONCURRENCY = 4
export const SWARM_MAX_CONCURRENCY = 8

export type SwarmStrategy = "fanout" | "pipeline" | "vote"

export interface SwarmTask {
  name: string
  prompt: string
  subagentType?: string
  model?: string
  isolation?: string
}

export interface SwarmWorker {
  name: string
  prompt: string
  subagentType: string
}

function normalizeTasks(raw: unknown): SwarmTask[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((value) => {
      return {
        name: String(value.name ?? "swarm-worker"),
        prompt: String(value.prompt ?? ""),
        subagentType: value.subagent_type ? String(value.subagent_type) : undefined,
        model: value.model ? String(value.model) : undefined,
        isolation: value.isolation ? String(value.isolation) : undefined,
      }
    })
    .filter((task) => task.prompt.trim().length > 0)
    .slice(0, SWARM_MAX_WORKERS)
}

/**
 * Expand a goal + strategy into concrete workers. Pure.
 * Vote fans the same goal out to N independent voters; fanout/pipeline
 * run the model's own decomposition (the orchestrator pattern — the model
 * plans, the swarm executes).
 */
export function buildSwarmWorkers(
  goal: string,
  strategy: SwarmStrategy,
  tasks: SwarmTask[],
  workers: number,
  subagentType: string,
): SwarmWorker[] {
  if (strategy === "vote") {
    const asked = Number.isFinite(workers) ? Math.floor(workers) : 3
    const count = Math.max(SWARM_MIN_VOTERS, Math.min(SWARM_MAX_VOTERS, asked))
    return Array.from({ length: count }, (_, i) => ({
      name: `swarm-voter-${i + 1}`,
      prompt:
        `You are voter ${i + 1} of ${count} in an SKT Swarm independent vote.\n` +
        `Goal: ${goal}\n\n` +
        `Answer INDEPENDENTLY — do not hedge toward other voters, they cannot see you. ` +
        `End with a single line verdict: ANSWER: <your conclusion>.`,
      subagentType,
    }))
  }
  return tasks
    .filter((task): task is SwarmTask => typeof task === "object" && task !== null)
    .map((task, i) => ({
      name: task.name || `swarm-worker-${i + 1}`,
      prompt: task.prompt,
      subagentType: task.subagentType ?? subagentType,
    }))
}

/** Assemble worker outputs into a synthesis-ready report. Pure. */
export function synthesizeSwarm(
  goal: string,
  strategy: SwarmStrategy,
  results: Array<{ name: string; text?: string; error?: string }>,
): string {
  const lines = results.map((r) =>
    r.error ? `### ${r.name}\nERROR: ${r.error}` : `### ${r.name}\n${(r.text ?? "").trim().slice(0, 4000)}`,
  )
  const succeeded = results.filter((r) => !r.error).length
  const next =
    strategy === "vote"
      ? "Take the majority verdict as the answer. On a tie, prefer the verdict with cited evidence (file paths, test output, logs); say explicitly that the vote tied."
      : "Synthesize the worker outputs into the final result: keep what is consistent across workers, resolve conflicts in favor of cited evidence, then act on the synthesis."
  return (
    `## SKT Swarm report (${strategy})\n` +
    `Goal: ${goal}\n` +
    `Workers heard: ${succeeded}/${results.length}.\n\n${lines.join("\n\n")}\n\n### Synthesis\n${next}`
  )
}

function clampConcurrency(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : SWARM_DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(SWARM_MAX_CONCURRENCY, n))
}

const definition: ToolDefinition = {
  timeoutMs: 120_000,
  name: "skt__Swarm",
  description:
    "SKT Swarm orchestrator: fan out a goal to parallel specialist workers and synthesize. Strategies: fanout (parallel subtasks), pipeline (sequential chain, each sees prior outputs), vote (N independent voters, majority wins). The model decomposes; the swarm executes.",
  parameters: {
    type: "object",
    required: ["goal"],
    properties: {
      goal: { type: "string", description: "The mission statement every worker serves." },
      strategy: {
        type: "string",
        enum: ["fanout", "pipeline", "vote"],
        description: "Orchestration strategy (default fanout).",
      },
      tasks: {
        type: "array",
        description: "Subtasks for fanout/pipeline: {name, prompt, subagent_type?, model?, isolation?}.",
        items: {
          type: "object",
          description: "Swarm subtask with name and prompt.",
        },
      },
      workers: {
        type: "number",
        description: "Voter count for vote strategy (2-7, default 3).",
      },
      concurrency: {
        type: "number",
        description: "Max parallel workers per batch (1-8, default 4). Pipeline always runs serially.",
      },
      subagent_type: {
        type: "string",
        description: "Default specialist profile for workers without one.",
      },
    },
  },
}

export type SwarmRunner = (
  tasks: TeamTask[],
) => Promise<Array<{ name: string; text: string; error?: string; background?: boolean; subagentId?: string }>>

export function createSwarmTool(onRunTeam?: SwarmRunner): Tool {
  return {
    definition,
    async execute(_id, args) {
      if (!onRunTeam) return textResult("Team runner is unavailable.", /*isError*/ true)
      const goal = String(args.goal ?? "").trim()
      if (!goal) return textResult("Missing required parameter: goal", /*isError*/ true)
      const rawStrategy = String(args.strategy ?? "fanout")
        .trim()
        .toLowerCase()
      if (rawStrategy !== "fanout" && rawStrategy !== "pipeline" && rawStrategy !== "vote") {
        return textResult("Unknown strategy: use fanout, pipeline, or vote.", /*isError*/ true)
      }
      const strategy: SwarmStrategy = rawStrategy
      const subagentType = String(args.subagent_type ?? "general").trim() || "general"

      if (strategy === "vote") {
        const rawWorkers = typeof args.workers === "number" ? args.workers : 3
        if (!Number.isFinite(rawWorkers) || Math.floor(rawWorkers) < SWARM_MIN_VOTERS) {
          return textResult(`Vote needs at least ${SWARM_MIN_VOTERS} workers.`, /*isError*/ true)
        }
        const workers = buildSwarmWorkers(goal, strategy, [], rawWorkers, subagentType)
        const results = await onRunTeam(
          workers.map((w) => ({ name: w.name, prompt: w.prompt, subagentType: w.subagentType, background: false })),
        )
        return textResult(synthesizeSwarm(goal, strategy, results))
      }

      const tasks = normalizeTasks(args.tasks)
      if (tasks.length === 0) {
        return textResult(
          `Strategy '${strategy}' needs a non-empty 'tasks' array — decompose the goal into subtasks first, then swarm them.`,
          /*isError*/ true,
        )
      }
      const workers = buildSwarmWorkers(goal, strategy, tasks, 0, subagentType)
      const indexed = workers.map((w, i) => ({ worker: w, task: tasks[i] as SwarmTask }))

      if (strategy === "pipeline") {
        const results: Array<{ name: string; text?: string; error?: string }> = []
        let prior = ""
        for (const { worker, task } of indexed) {
          const prompt =
            prior.length > 0
              ? `${worker.prompt}\n\nPrevious workers' outputs (build on them, do not redo them):\n${prior}`
              : worker.prompt
          const batch = await onRunTeam([
            {
              name: worker.name,
              prompt,
              subagentType: worker.subagentType,
              model: task.model,
              isolation: task.isolation,
              background: false,
            },
          ])
          const first = batch[0] as { name: string; text: string; error?: string } | undefined
          const entry = { name: worker.name, text: first?.text ?? "", error: first?.error }
          results.push(entry)
          if (!entry.error && entry.text.trim().length > 0) {
            prior += `\n\n[${entry.name}]:\n${entry.text.trim().slice(0, 2000)}`
          }
        }
        return textResult(synthesizeSwarm(goal, strategy, results))
      }

      const concurrency = clampConcurrency(args.concurrency)
      const results: Array<{ name: string; text?: string; error?: string }> = []
      for (let i = 0; i < indexed.length; i += concurrency) {
        const batch = await onRunTeam(
          indexed.slice(i, i + concurrency).map(({ worker, task }) => ({
            name: worker.name,
            prompt: worker.prompt,
            subagentType: worker.subagentType,
            model: task.model,
            isolation: task.isolation,
            background: false,
          })),
        )
        for (const r of batch) results.push({ name: r.name, text: r.text, error: r.error })
      }
      return textResult(synthesizeSwarm(goal, strategy, results))
    },
  }
}

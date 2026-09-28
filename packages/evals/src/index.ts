/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { runCodingTask } from "../../coding-agent/src/index.js"

export interface EvalTask {
  name: string
  prompt: string
  /** Substring that must appear in the final assistant answer or a tool call. */
  expect: string
}

export interface EvalResult {
  name: string
  passed: boolean
  detail: string
}

/**
 * A lightweight evaluation harness. Each task runs through the coding agent and
 * is checked for an expected substring in the resulting transcript.
 */
export async function runEvals(tasks: EvalTask[]): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (const task of tasks) {
    try {
      const events = await runCodingTask(task.prompt)
      const transcript = events
        .map((e) => {
          if (e.type === "message_end" && e.message.role === "assistant") {
            return e.message.content.map((c) => ("text" in c ? c.text : "")).join(" ")
          }
          if (e.type === "tool_execution_start") {
            return `tool:${e.toolName}`
          }
          return ""
        })
        .join(" ")
      const passed = transcript.includes(task.expect)
      results.push({ name: task.name, passed, detail: passed ? "ok" : `expected "${task.expect}" not found` })
    } catch (err) {
      results.push({ name: task.name, passed: false, detail: String(err) })
    }
  }
  return results
}

export function reportEvals(results: EvalResult[]): void {
  for (const r of results) {
    process.stdout.write(`${r.passed ? "PASS" : "FAIL"}  ${r.name}  (${r.detail})\n`)
  }
  const failed = results.filter((r) => !r.passed).length
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
}

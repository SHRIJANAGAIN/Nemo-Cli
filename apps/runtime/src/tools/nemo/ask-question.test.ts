/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../types.js"
import { createAskUserQuestionTool } from "./ask-question.js"

const text = (res: ToolResult): string => res.content.map((c) => c.text ?? "").join("\n")

interface ReceivedQuestion {
  question: string
  header?: string
  options: Array<{ label: string; description: string }>
  multi_select: boolean
}

describe("AskUserQuestion fan-out guards", () => {
  it("caps the question count with a truncation note", async () => {
    const onAsk = vi.fn().mockResolvedValue(["a"])
    const questions = Array.from({ length: 50 }, (_, i) => ({
      question: `q${i}`,
      header: `h${i}`,
      options: [{ label: "yes" }, { label: "no" }],
      multi_select: false,
    }))
    const tool = createAskUserQuestionTool(onAsk)
    const res = await tool.execute("t1", { questions }, undefined)
    const received = onAsk.mock.calls[0][0] as ReceivedQuestion[]
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(10)
    expect(text(res)).toContain("10 of 50")
  })

  it("caps options per question", async () => {
    const onAsk = vi.fn().mockResolvedValue(["ok"])
    const options = Array.from({ length: 40 }, (_, i) => ({ label: `o${i}` }))
    const tool = createAskUserQuestionTool(onAsk)
    const res = await tool.execute("t1", { questions: [{ question: "pick", options, multi_select: false }] }, undefined)
    const received = onAsk.mock.calls[0][0] as ReceivedQuestion[]
    expect(received[0].options).toHaveLength(10)
    expect(text(res)).toContain("options capped at 10")
  })

  it("clips oversized question, label, and description text", async () => {
    const onAsk = vi.fn().mockResolvedValue(["a"])
    const tool = createAskUserQuestionTool(onAsk)
    await tool.execute(
      "t1",
      {
        questions: [
          {
            question: "x".repeat(10_000),
            options: [{ label: "y".repeat(5_000), description: "z".repeat(9_000) }],
            multi_select: true,
          },
        ],
      },
      undefined,
    )
    const received = onAsk.mock.calls[0][0] as ReceivedQuestion[]
    expect(received[0].question.length).toBeLessThanOrEqual(501)
    expect(received[0].question.endsWith("…")).toBe(true)
    expect(received[0].options[0].label.length).toBeLessThanOrEqual(201)
    expect(received[0].options[0].description.length).toBeLessThanOrEqual(301)
    expect(received[0].multi_select).toBe(true)
  })

  it("forwards the per-question header", async () => {
    const onAsk = vi.fn().mockResolvedValue(["a"])
    const tool = createAskUserQuestionTool(onAsk)
    await tool.execute(
      "t1",
      { questions: [{ question: "confirm?", header: "Deploy", options: [{ label: "yes" }], multi_select: false }] },
      undefined,
    )
    const received = onAsk.mock.calls[0][0] as ReceivedQuestion[]
    expect(received[0].header).toBe("Deploy")
  })

  it("keeps the listing fallback bounded", async () => {
    const questions = Array.from({ length: 30 }, (_, i) => ({
      question: `q${i}`,
      options: [{ label: "go" }],
      multi_select: false,
    }))
    const tool = createAskUserQuestionTool()
    const res = await tool.execute("t1", { questions }, undefined)
    expect(res.isError).toBeFalsy()
    expect(text(res)).toContain("[awaiting user input]")
    expect(text(res)).toContain("10 of 30")
    expect(text(res).split("Q: ").length - 1).toBe(10)
  })

  it("still errors when no questions are provided", async () => {
    const tool = createAskUserQuestionTool()
    const res = await tool.execute("t1", { questions: [] }, undefined)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain("Missing 'questions'")
  })
})

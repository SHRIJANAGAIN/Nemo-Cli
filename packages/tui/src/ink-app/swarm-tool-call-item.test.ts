/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { resetGlyphCache } from "./glyphs.js"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { ToolCallItem } from "./ToolCallItem.js"
import { describeSwarmCall } from "./SwarmToolCallItem.js"
import type { ToolCallDisplay } from "./types.js"

/**
 * SKT Swarm row coverage — the orchestrator must be visible while it runs
 * (animated worker chase + strategy + goal) and settle to a static summary
 * when done (no interval left behind to churn the transcript).
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function renderFrames(toolCall: ToolCallDisplay, settleMs = 500): Promise<string> {
  const raw = new PassThrough()
  let sink = ""
  raw.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns: 100, rows: 40 }) as unknown as NodeJS.WriteStream

  let instance: Instance | undefined
  try {
    instance = render(
      React.createElement(ToolCallItem, { toolCall, shouldAnimate: true, shouldShowDot: true, addMargin: false }),
      { stdout, patchConsole: false },
    )
    await wait(settleMs)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return stripAnsi(sink)
}

const RUNNING_SWARM: ToolCallDisplay = {
  id: "sw1",
  name: "skt__Swarm",
  args: {
    goal: "ship the feature",
    strategy: "fanout",
    tasks: [
      { name: "fe", prompt: "build ui" },
      { name: "be", prompt: "build api" },
      { name: "qa", prompt: "test it" },
    ],
  },
  status: "running",
}

const DONE_SWARM: ToolCallDisplay = {
  id: "sw2",
  name: "skt__Swarm",
  args: { goal: "ship the feature", strategy: "vote", workers: 3 },
  status: "completed",
  result: "## SKT Swarm report (vote)",
}

process.env.TRAYAMBAK_GLYPHS = "unicode"
resetGlyphCache()

describe("describeSwarmCall", () => {
  it("counts explicit tasks for fanout and pipeline", () => {
    expect(describeSwarmCall({ goal: "g", strategy: "fanout", tasks: [{}, {}] })).toEqual({
      goal: "g",
      strategy: "fanout",
      workerCount: 2,
    })
    expect(describeSwarmCall({ goal: "g", strategy: "pipeline", tasks: [{}] }).workerCount).toBe(1)
  })

  it("expands vote workers with clamping and defaults", () => {
    expect(describeSwarmCall({ goal: "g", strategy: "vote", workers: 5 }).workerCount).toBe(5)
    expect(describeSwarmCall({ goal: "g", strategy: "vote", workers: 99 }).workerCount).toBe(7)
    expect(describeSwarmCall({ goal: "g", strategy: "vote" }).workerCount).toBe(3)
  })

  it("falls back to fanout with zero workers on unknown shapes", () => {
    expect(describeSwarmCall({})).toEqual({ goal: "", strategy: "fanout", workerCount: 0 })
    expect(describeSwarmCall({ goal: "g", strategy: "teleport" }).strategy).toBe("fanout")
  })
})

describe("SwarmToolCallItem via ToolCallItem dispatch", () => {
  it("animates the running swarm with strategy, goal, and worker count", async () => {
    const frames = await renderFrames(RUNNING_SWARM)

    expect(frames).toContain("SKT Swarm")
    expect(frames).toContain("fanout")
    expect(frames).toContain("ship the feature")
    expect(frames).toContain("3 worker")
  }, 15000)

  it("settles a finished swarm to a static workers-heard summary", async () => {
    const frames = await renderFrames(DONE_SWARM)

    expect(frames).toContain("skt__Swarm")
    expect(frames).toContain("vote")
    expect(frames).toContain("3 workers heard")
  }, 15000)

  it("paints worker errors as failed, not heard", async () => {
    const frames = await renderFrames({ ...DONE_SWARM, status: "error", isError: true })

    expect(frames).toContain("skt__Swarm")
    expect(frames).toContain("3 workers heard")
  }, 15000)
})

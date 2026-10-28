/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Harness runtime coverage — the harness itself had no tests while every
 * agent turn depends on it (facts persistence, event caps, snapshots).
 *
 * Deterministic by construction: every test gets a fresh `mkdtemp` cwd so
 * no real `.nemo/harness.json` is ever touched — no network, no
 * ambient state.
 */

import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HarnessRuntime, RecursiveTaskRuntime, type HarnessPlugin } from "./index.js"

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemo-harness-"))
}

function turnStart(prompt: string): { type: "turn_start"; prompt: string } {
  return { type: "turn_start", prompt }
}

describe("HarnessRuntime state", () => {
  it("starts empty with the given session id and an empty context", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_1")

    expect(runtime.state.sessionId).toBe("sess_1")
    expect(runtime.state.facts).toEqual({})
    expect(runtime.state.events).toEqual([])
    expect(runtime.state.snapshots).toEqual([])
    expect(runtime.context()).toBe("")
  })

  it("persists facts so a new instance on the same cwd reloads them", async () => {
    const cwd = tempCwd()
    const first = new HarnessRuntime(cwd, "sess_persist")
    first.state.facts["goal"] = "ship"
    await first.emit(turnStart("hi"))

    const second = new HarnessRuntime(cwd, "sess_other")
    expect(second.state.sessionId).toBe("sess_persist") // stored id wins
    expect(second.state.facts["goal"]).toBe("ship")
    expect(second.state.events).toHaveLength(1)
  })

  it("setFact/getFact round-trip through the shared context", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_facts")

    expect(runtime.state.facts["missing"]).toBeUndefined()
    runtime.state.facts["k"] = "v"
    expect(runtime.state.facts["k"]).toBe("v")
  })

  it("caps retained events at 100, dropping the oldest", async () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_cap")
    for (let i = 0; i < 105; i++) {
      await runtime.emit(turnStart(`prompt-${i}`))
    }

    expect(runtime.state.events).toHaveLength(100)
    expect(runtime.state.events[0]).toEqual(turnStart("prompt-5"))
    expect(runtime.state.events[99]).toEqual(turnStart("prompt-104"))
  })
})

describe("HarnessRuntime plugins", () => {
  it("runs setup once, fans out events, and exposes plugin context", async () => {
    const cwd = tempCwd()
    const runtime = new HarnessRuntime(cwd, "sess_plugin")
    let setups = 0
    const seen: string[] = []
    const plugin: HarnessPlugin = {
      name: "probe",
      setup: () => {
        setups += 1
      },
      onEvent: (event) => {
        seen.push(event.type)
      },
      context: () => "plugin says hi",
    }

    await runtime.register(plugin)
    await runtime.register(plugin) // duplicate registration is ignored
    await runtime.emit(turnStart("go"))

    expect(setups).toBe(1)
    expect(seen).toEqual(["turn_start"])
    expect(runtime.context()).toContain("plugin says hi")
  })

  it("renders durable facts as a context block", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_ctx")
    runtime.state.facts["owner"] = "nemo"
    runtime.state.facts["mode"] = "hunt"

    const ctx = runtime.context()
    expect(ctx).toContain("Durable harness facts:")
    expect(ctx).toContain("- owner: nemo")
    expect(ctx).toContain("- mode: hunt")
  })
})

describe("HarnessRuntime snapshots", () => {
  it("rolls facts back to a labelled snapshot", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_snap")
    runtime.state.facts["a"] = "1"
    const id = runtime.snapshot("before")

    runtime.state.facts["a"] = "2"
    runtime.rollback(id)

    expect(runtime.state.facts["a"]).toBe("1")
  })

  it("defaults a blank label to checkpoint", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_label")
    const id = runtime.snapshot("   ")

    expect(runtime.state.snapshots.find((s) => s.id === id)?.label).toBe("checkpoint")
  })

  it("throws for an unknown snapshot id", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_missing")

    expect(() => runtime.rollback("nope")).toThrow("Harness snapshot not found: nope")
  })

  it("caps retained snapshots at 20", () => {
    const runtime = new HarnessRuntime(tempCwd(), "sess_snapcap")
    for (let i = 0; i < 21; i++) {
      runtime.snapshot(`s${i}`)
    }

    expect(runtime.state.snapshots).toHaveLength(20)
    expect(runtime.state.snapshots[0]?.label).toBe("s1")
  })
})

describe("RecursiveTaskRuntime", () => {
  it("runs a task and returns its value", async () => {
    const runtime = new RecursiveTaskRuntime()

    await expect(runtime.run({ name: "t", run: async () => 42 })).resolves.toBe(42)
  })

  it("rejects work past the max depth", async () => {
    const runtime = new RecursiveTaskRuntime(/*maxDepth*/ 1, /*maxParallel*/ 3)

    await expect(runtime.run({ name: "deep", run: async () => 1 }, /*depth*/ 2)).rejects.toThrow(
      "Recursive task depth exceeded (1).",
    )
  })

  it("runs parallel tasks and returns every result", async () => {
    const runtime = new RecursiveTaskRuntime(/*maxDepth*/ 3, /*maxParallel*/ 3)

    await expect(
      runtime.runParallel([
        { name: "a", run: async () => "a" },
        { name: "b", run: async () => "b" },
      ]),
    ).resolves.toEqual(["a", "b"])
  })

  it("rejects parallel batches past the limit", async () => {
    const runtime = new RecursiveTaskRuntime(/*maxDepth*/ 3, /*maxParallel*/ 1)

    await expect(
      runtime.runParallel([
        { name: "a", run: async () => "a" },
        { name: "b", run: async () => "b" },
      ]),
    ).rejects.toThrow("Parallel task limit exceeded (1).")
  })
})

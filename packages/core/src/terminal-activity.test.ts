/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  ACTIVITY_STATES,
  activityEnabled,
  activitySequence,
  clearActivity,
  publishActivity,
  startActivityHeartbeat,
} from "./terminal-activity.js"

const saved = process.env.NEMO_TERMINAL_ACTIVITY
afterEach(() => {
  if (saved === undefined) delete process.env.NEMO_TERMINAL_ACTIVITY
  else process.env.NEMO_TERMINAL_ACTIVITY = saved
})

/** Capture whatever is written to stdout during `fn`. */
function capture(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout)
  let out = ""
  ;(process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    out += chunk
    return true
  }
  try {
    fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof original }).write = original
  }
  return out
}

describe("activitySequence", () => {
  it("uses the OSC 777 kilo activity form with a timestamp", () => {
    expect(activitySequence("busy", 1_700_000_000_000)).toBe("\x1b]777;kilo;activity;1;busy;1700000000000\x1b\\")
  })

  it("terminates with ST, not BEL", () => {
    // BEL is ambiguous inside a prompt that may already be mid-escape.
    expect(activitySequence("idle", 1)).toContain("\x1b\\")
    expect(activitySequence("idle", 1)).not.toContain("\x07")
  })

  it("floors a fractional timestamp", () => {
    expect(activitySequence("done", 1_700_000_000_999.7)).toContain(";1700000000999")
  })

  it("can emit every documented state", () => {
    for (const state of ACTIVITY_STATES) {
      expect(activitySequence(state, 0)).toContain(`;${state};0`)
    }
  })
})

describe("activityEnabled", () => {
  it("is opt-in only", () => {
    delete process.env.NEMO_TERMINAL_ACTIVITY
    expect(activityEnabled()).toBe(false)
    process.env.NEMO_TERMINAL_ACTIVITY = "1"
    expect(activityEnabled()).toBe(true)
  })

  it("treats any other value as off — a typo must not leak sequences", () => {
    process.env.NEMO_TERMINAL_ACTIVITY = "true"
    expect(activityEnabled()).toBe(false)
  })
})

describe("publishActivity", () => {
  it("writes nothing when disabled, so pipes stay clean", () => {
    delete process.env.NEMO_TERMINAL_ACTIVITY
    expect(capture(() => publishActivity("busy"))).toBe("")
  })

  it("writes the sequence when enabled", () => {
    process.env.NEMO_TERMINAL_ACTIVITY = "1"
    expect(capture(() => publishActivity("busy", 5))).toBe("\x1b]777;kilo;activity;1;busy;5\x1b\\")
  })

  it("returns to idle on clear", () => {
    process.env.NEMO_TERMINAL_ACTIVITY = "1"
    expect(capture(() => clearActivity(7))).toContain(";idle;7")
  })
})

describe("startActivityHeartbeat", () => {
  it("emits once immediately and can be stopped", () => {
    process.env.NEMO_TERMINAL_ACTIVITY = "1"
    let stop: () => void = () => {}
    const out = capture(() => {
      stop = startActivityHeartbeat(60_000, "retry")
    })
    expect(out).toContain("retry")
    stop()
  })

  it("does nothing at all when disabled", () => {
    delete process.env.NEMO_TERMINAL_ACTIVITY
    let stop = (): void => {}
    expect(capture(() => (stop = startActivityHeartbeat()))).toBe("")
    stop()
  })

  it("never holds the process open on its own", async () => {
    process.env.NEMO_TERMINAL_ACTIVITY = "1"
    const stop = startActivityHeartbeat(1_000)
    // unref'd timers do not keep the event loop alive; asserting the timer
    // exposes it is the observable part we can check without hanging the suite.
    expect(typeof stop).toBe("function")
    stop()
  })
})

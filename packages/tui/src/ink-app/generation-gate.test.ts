/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Gate contract for the working/parked/idle transitions.
 *
 * The invariant under test is the one that broke scrolling before: mouse
 * reporting must never be left ON while the agent is idle, because that is what
 * kills the device scrollbar.
 */
import { describe, expect, it } from "vitest"
import { GenerationGate, MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON } from "./generation-gate.js"

/** Collects every sequence written, so assertions can be about ORDER too. */
function harness(interactive = true) {
  const written: string[] = []
  const gate = new GenerationGate({ write: (s) => written.push(s), interactive })
  return { gate, written }
}

describe("GenerationGate — idle", () => {
  it("starts idle with the terminal untouched", () => {
    const { gate, written } = harness()
    expect(gate.current).toBe("idle")
    expect(gate.intercepting).toBe(false)
    expect(written).toEqual([])
  })

  it("leaves reporting off when a turn starts without a terminal", () => {
    // Non-interactive (pipe, CI): nothing to report to, nothing to detect, so
    // the device must keep whatever native behaviour it has.
    const { gate, written } = harness(/*interactive*/ false)
    gate.enterWorking()
    expect(written).toEqual([])
    expect(gate.intercepting).toBe(false)
  })
})

describe("GenerationGate — working", () => {
  it("takes the wheel only while a turn is producing output", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    expect(written).toEqual([MOUSE_REPORTING_ON])
    expect(gate.intercepting).toBe(true)
  })

  it("does not re-send the sequence when a turn re-enters working", () => {
    // Re-entrant turns are normal (tool loop, retries); a second write would be
    // noise at best and a desync at worst.
    const { gate, written } = harness()
    gate.enterWorking()
    gate.enterWorking()
    expect(written).toHaveLength(1)
  })
})

describe("GenerationGate — parked (the hand-back)", () => {
  it("returns the wheel the moment the user scrolls away", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    gate.park()
    expect(written).toEqual([MOUSE_REPORTING_ON, MOUSE_REPORTING_OFF])
    expect(gate.current).toBe("parked")
    expect(gate.intercepting).toBe(false)
  })

  it("gives the wheel back on the FIRST park and keeps it back", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    gate.park()
    gate.park()
    gate.park()
    expect(written).toHaveLength(2)
  })

  it("ignores a park that arrives while idle", () => {
    // A stray wheel event between turns must not emit anything.
    const { gate, written } = harness()
    gate.park()
    expect(written).toEqual([])
    expect(gate.current).toBe("idle")
  })
})

describe("GenerationGate — never strands reporting", () => {
  it("releases when a turn ends from parked", () => {
    // The dangerous path: parked means reporting is already off, so ending here
    // must be a no-op rather than a second OFF (or, worse, nothing).
    const { gate, written } = harness()
    gate.enterWorking()
    gate.park()
    gate.enterIdle()
    expect(written).toEqual([MOUSE_REPORTING_ON, MOUSE_REPORTING_OFF])
    expect(gate.current).toBe("idle")
  })

  it("releases when a turn ends from working", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    gate.enterIdle()
    expect(written).toEqual([MOUSE_REPORTING_ON, MOUSE_REPORTING_OFF])
  })

  it("releases on unmount/abort so reporting cannot outlive the app", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    gate.release()
    expect(written[written.length - 1]).toBe(MOUSE_REPORTING_OFF)
    expect(gate.intercepting).toBe(false)
  })

  it("survives a full turn cycle and lands back on idle", () => {
    const { gate, written } = harness()
    gate.enterWorking()
    gate.park()
    gate.enterIdle()
    gate.enterWorking()
    gate.enterIdle()
    expect(written).toEqual([MOUSE_REPORTING_ON, MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON, MOUSE_REPORTING_OFF])
    expect(gate.current).toBe("idle")
  })
})

describe("MOUSE_REPORTING_OFF covers every mode", () => {
  it("disables all five tracking modes", () => {
    // Miss one and the terminal keeps routing the wheel to the app: basic,
    // button-event, any-event, SGR and urxvt coords are independent switches.
    for (const mode of ["1000", "1002", "1003", "1006", "1015"]) {
      expect(MOUSE_REPORTING_OFF).toContain(`\x1b[?${mode}l`)
    }
  })

  it("enables only the two modes needed to read a wheel event", () => {
    expect(MOUSE_REPORTING_ON).toContain("\x1b[?1000h")
    expect(MOUSE_REPORTING_ON).toContain("\x1b[?1006h")
    // 1003 (any-event) is far noisier than needed and costs extra traffic.
    expect(MOUSE_REPORTING_ON).not.toContain("\x1b[?1003h")
  })
})

describe("GenerationGate - alt-screen (App owns the wheel)", () => {
  it("never writes reporting sequences when altScreen is set", () => {
    const written: string[] = [];
    const gate = new GenerationGate({ write: (s) => written.push(s), interactive: true, altScreen: true });
    gate.enterWorking();
    gate.park();
    gate.enterIdle();
    gate.release();
    expect(written).toEqual([]);
    expect(gate.intercepting).toBe(false);
  });

  it("defaults to App-unowned (inline) behavior without the flag", () => {
    const written: string[] = [];
    const gate = new GenerationGate({ write: (s) => written.push(s), interactive: true });
    gate.enterWorking();
    expect(written).toEqual([MOUSE_REPORTING_ON]);
  });
});

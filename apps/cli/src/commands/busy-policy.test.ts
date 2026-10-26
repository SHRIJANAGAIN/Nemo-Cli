/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `busyPolicy` enforcement in the slash-command dispatcher.
 *
 * The field was declared on `SlashCommandDef` in both registries and read by
 * neither. A command marked `reject` dispatched while a turn was running — the
 * one behaviour the field exists to prevent.
 *
 * Each test pins a way this wiring fails while still reading as a control:
 *
 *  - **Refusing but looking like output.** A refusal and a successful run both
 *    render as text. A caller that cannot tell them apart treats "not allowed
 *    right now" as the command's opinion, and retries wrong.
 *  - **The interrupt that never happened.** `interrupt_then_dispatch` with no
 *    interrupter must NOT quietly become `reject`, and must NOT report success
 *    having run nothing. The caller asked for the command to run.
 *  - **The default.** A command with no policy, or a caller with no busy state,
 *    must dispatch exactly as before — otherwise wiring the control breaks every
 *    command that never mentioned it.
 *  - **Interrupt ordering.** The interrupt must settle before the handler runs,
 *    or the command executes against a turn that is still tearing down.
 */

import { describe, expect, it } from "vitest"

import { buildNemoSlashRegistry, dispatchSlashCommandAsync } from "./command-dispatch.js"
import type { BusyState } from "./command-dispatch.js"
import { SlashCommandRegistry, type SlashCommandDef } from "./registry.js"
import type { NemoConfig } from "../../../runtime/src/index.js"

const CONFIG = {} as NemoConfig

function registryWith(def: Partial<SlashCommandDef> & { name: string }): SlashCommandRegistry {
  const registry = new SlashCommandRegistry()
  registry.register({
    description: "test",
    category: "Session",
    handler: async () => "RAN",
    ...def,
  } as SlashCommandDef)
  return registry
}

/** A busy state that records the order in which things happened. */
function busyState(log: string[], withInterrupt = true): BusyState {
  return {
    isBusy: () => true,
    interrupt:
      withInterrupt
        ? async () => {
            log.push("interrupt")
          }
        : undefined,
  }
}

describe("busyPolicy — reject", () => {
  it("refuses to dispatch while a turn is running", async () => {
    const registry = registryWith({ name: "guarded", busyPolicy: "reject" })
    const result = await dispatchSlashCommandAsync(registry, "/guarded", CONFIG, {
      busy: busyState([]),
    })
    expect(result.refusedBy).toBe("busyPolicy")
    expect(result.output).toContain("not allowed while a turn is running")
  })

  it("marks the refusal so it cannot be mistaken for command output", async () => {
    // Both render as text. A caller that cannot tell "refused" from "ran and
    // complained" retries the wrong thing.
    const registry = registryWith({ name: "guarded", busyPolicy: "reject" })
    const refused = await dispatchSlashCommandAsync(registry, "/guarded", CONFIG, { busy: busyState([]) })
    expect(refused.matched).toBe(true)
    expect(refused.output).not.toBe("RAN")
  })

  it("dispatches normally when idle", async () => {
    const registry = registryWith({ name: "guarded", busyPolicy: "reject" })
    const result = await dispatchSlashCommandAsync(registry, "/guarded", CONFIG, {
      busy: { isBusy: () => false },
    })
    expect(result.output).toBe("RAN")
    expect(result.refusedBy).toBeUndefined()
  })
})

describe("busyPolicy — interrupt_then_dispatch", () => {
  it("interrupts, then dispatches", async () => {
    const log: string[] = []
    const registry = registryWith({
      name: "interruptible",
      busyPolicy: "interrupt_then_dispatch",
      handler: async () => {
        log.push("handler")
        return "RAN"
      },
    })
    const result = await dispatchSlashCommandAsync(registry, "/interruptible", CONFIG, { busy: busyState(log) })
    expect(result.output).toBe("RAN")
    expect(result.interrupted).toBe(true)
  })

  it("lets the interrupt SETTLE before the handler runs", async () => {
    // Otherwise the command executes against a turn that is still tearing down,
    // which is the race the policy exists to prevent.
    const log: string[] = []
    const registry = registryWith({
      name: "interruptible",
      busyPolicy: "interrupt_then_dispatch",
      handler: async () => {
        log.push("handler")
        return "RAN"
      },
    })
    await dispatchSlashCommandAsync(registry, "/interruptible", CONFIG, { busy: busyState(log) })
    expect(log).toEqual(["interrupt", "handler"])
  })

  it("does NOT interrupt when idle", async () => {
    const log: string[] = []
    const registry = registryWith({ name: "interruptible", busyPolicy: "interrupt_then_dispatch" })
    await dispatchSlashCommandAsync(registry, "/interruptible", CONFIG, {
      busy: {
        isBusy: () => false,
        interrupt: async () => {
          log.push("interrupt")
        },
      },
    })
    expect(log).toEqual([])
  })

  it("refuses rather than pretending, when no interrupter is available", async () => {
    // Not a silent fallback to `reject`, and not a success that ran nothing. The
    // caller asked for the command to run; say plainly that it cannot be.
    const registry = registryWith({ name: "interruptible", busyPolicy: "interrupt_then_dispatch" })
    const result = await dispatchSlashCommandAsync(registry, "/interruptible", CONFIG, {
      busy: busyState([], false),
    })
    expect(result.output).not.toBe("RAN")
    expect(result.refusedBy).toBe("busyPolicy")
    expect(result.output).toContain("no interrupter was provided")
  })
})

describe("busyPolicy — the default", () => {
  it("dispatches a command with no policy while busy", async () => {
    // Otherwise wiring the control breaks every command that never mentioned it.
    const registry = registryWith({ name: "plain" })
    const result = await dispatchSlashCommandAsync(registry, "/plain", CONFIG, { busy: busyState([]) })
    expect(result.output).toBe("RAN")
  })

  it("dispatches when the caller supplies no busy state at all", async () => {
    // The previous signature. Preserving it is what makes the control additive.
    const registry = registryWith({ name: "guarded", busyPolicy: "reject" })
    const result = await dispatchSlashCommandAsync(registry, "/guarded", CONFIG)
    expect(result.output).toBe("RAN")
  })

  it("dispatches `dispatch` explicitly while busy", async () => {
    const registry = registryWith({ name: "explicit", busyPolicy: "dispatch" })
    const result = await dispatchSlashCommandAsync(registry, "/explicit", CONFIG, { busy: busyState([]) })
    expect(result.output).toBe("RAN")
  })
})

describe("busyPolicy — errors and resolution still work", () => {
  it("reports a handler error the same way", async () => {
    const registry = registryWith({
      name: "boom",
      handler: async () => {
        throw new Error("kaboom")
      },
    })
    const result = await dispatchSlashCommandAsync(registry, "/boom", CONFIG, { busy: busyState([]) })
    expect(result.output).toContain("kaboom")
  })

  it("reports an unknown command before consulting busy state", async () => {
    // Nothing to interrupt for a name that does not resolve.
    const log: string[] = []
    const registry = new SlashCommandRegistry()
    const result = await dispatchSlashCommandAsync(registry, "/nope", CONFIG, { busy: busyState(log) })
    expect(result.matched).toBe(false)
    expect(log).toEqual([])
  })
})

describe("the real registry", () => {
  it("still builds and dispatches", async () => {
    // The shipped command set, not a fixture: a signature change here would be
    // invisible to tests that construct their own registry.
    const registry = buildNemoSlashRegistry()
    expect(registry.all().length).toBeGreaterThan(0)
    const result = await dispatchSlashCommandAsync(registry, "/definitely-not-a-command", CONFIG)
    expect(result.matched).toBe(false)
  })
})
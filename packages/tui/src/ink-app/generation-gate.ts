/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Generation gate — mouse reporting only while the agent is actually working.
 *
 * The trap this exists to close: reading history needs the DEVICE scrollbar,
 * and knowing whether the user has scrolled away from the live tail needs mouse
 * reporting — and those two are mutually exclusive, because any reporting mode
 * makes the terminal route wheel and drag events to the app instead of scrolling
 * its own buffer. That is why the offset state was deleted in the first place:
 * turning mouse on unconditionally killed the scrollbar, leaving no scroll at
 * all.
 *
 * The resolution is that the two are needed at DIFFERENT TIMES, not together:
 *
 *   idle      the user is reading. Nothing is streaming, so there is nothing to
 *             detect and nothing to protect. Reporting OFF, the device
 *             scrollbar owns the screen, and the transcript stays put.
 *   working   content is arriving. Yanking the view down is expected, but if the
 *             user scrolls away we must notice — so reporting comes ON, and only
 *             for this window.
 *   parked    the user scrolled up mid-generation. Reporting goes straight back
 *             OFF, handing the wheel to the terminal so they can scroll natively
 *             from that point on. We keep the single fact we needed (they left)
 *             and stop intercepting anything.
 *
 * Every transition is idempotent and only ever moves toward "reporting off", so a
 * repeated call, a re-entrant turn, or an unmount mid-turn cannot leave the
 * terminal in a mode it does not expect.
 */

/** Gate phases, in the order a turn moves through them. */
export type GatePhase = "idle" | "working" | "parked"

/** Escape sequences, grouped by intent. */
export const MOUSE_REPORTING_ON = "\x1b[?1000h\x1b[?1006h"
export const MOUSE_REPORTING_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l"

/** Minimal sink so the gate never reaches for `process` itself. */
export interface GateOptions {
  write: (sequence: string) => void
  /** Reporting is only safe when there is a real terminal to report to. */
  interactive?: boolean
  /**
   * Alternate-screen mode owns the wheel itself (App enables reporting on
   * mount for in-app transcript paging and disables it on teardown). The gate
   * must not touch reporting there — its wheel-release on park/scroll-away
   * would kill App's scrolling mid-turn. Phase bookkeeping is untouched.
   */
  altScreen?: boolean
}

export class GenerationGate {
  private phase: GatePhase = "idle"
  /**
   * Whether the terminal is CURRENTLY reporting, tracked separately from the
   * phase. Deriving it from the phase would make `parked` → `idle` emit a second
   * redundant OFF; worse, it would have no way to describe reporting being on
   * while the phase says otherwise. The flag is the wire truth.
   */
  private reporting = false
  private readonly write: (sequence: string) => void
  private readonly interactive: boolean
  private readonly altScreen: boolean

  constructor(options: GateOptions) {
    this.write = options.write
    this.interactive = options.interactive !== false
    this.altScreen = options.altScreen === true
  }

  get current(): GatePhase {
    return this.phase
  }

  /** True while the terminal is intercepting the wheel. */
  get intercepting(): boolean {
    return this.reporting
  }

  /** Emit the OFF sequence exactly once, and only when reporting is live. */
  private releaseWheel(): void {
    if (!this.reporting || this.altScreen) return
    this.reporting = false
    this.write(MOUSE_REPORTING_OFF)
  }

  /**
   * A turn started producing output. Take the wheel so a scroll-away can be
   * noticed. A no-op when non-interactive: there is no terminal to report to and
   * nothing to detect, so the device keeps its native scrolling. Also a no-op
   * in alt-screen mode: App owns reporting there for transcript paging.
   */
  enterWorking(): void {
    if (!this.interactive || this.reporting || this.altScreen) return
    this.phase = "working"
    this.reporting = true
    this.write(MOUSE_REPORTING_ON)
  }

  /**
   * The user scrolled away mid-generation — hand the wheel straight back so
   * scrolling is native from here, and stop intercepting. This is the whole
   * point: we take one fact from the window (they left) and give the wheel back
   * immediately rather than holding it for the rest of the turn.
   */
  park(): void {
    if (this.phase !== "working") return
    this.phase = "parked"
    this.releaseWheel()
  }

  /**
   * The turn ended. Releases the wheel if it is still held, so a turn that ends
   * while parked cannot strand mouse reporting on.
   */
  enterIdle(): void {
    this.phase = "idle"
    this.releaseWheel()
  }

  /** Release on unmount/abort — same guarantee as `enterIdle`. */
  release(): void {
    this.enterIdle()
  }
}

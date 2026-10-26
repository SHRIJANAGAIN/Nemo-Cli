/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Resize guard: a width change or a height SHRINK must blank the viewport and
 * wipe Ink's line bookkeeping, so the next render paints one whole frame from
 * (0,0) instead of erasing a stale line count from a stale cursor position.
 *
 * The height-shrink case is the boot frame leak: the frame is `rows - 1` tall,
 * so a shorter window leaves it taller than the window — every repaint writes
 * past the window's last row, the console scrolls a row per repaint, and the
 * frames stack up in scrollback (scripts/diag-conhost-replay.ps1 measures
 * +1 row/repaint for a one-row-taller frame, flat for an in-budget one).
 * Growth deliberately does NOT anchor: no re-flow, no scroll, no flicker.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createResizeRedrawGuard, type InkInstanceLike } from "./resize-guard.js"
import {
  registerFullRenderHandler,
  registerSettleReprintHandler,
  requestFullRender,
} from "./app-bootstrap.js"

const BLANK = "[2J[H"

/** Cursor home, no erase: what a rate-limited drag event gets. */
const HOME = "[H"

function harness(initial?: { columns?: number; rows?: number }) {
  const written: string[] = []
  const listeners: Array<() => void> = []
  const stdout = {
    columns: initial?.columns ?? 120,
    rows: initial?.rows ?? 30,
    on(event: "resize", listener: () => void) {
      if (event === "resize") listeners.push(listener)
      return stdout
    },
    write(chunk: string) {
      written.push(chunk)
      return true
    },
  }
  const log = { reset: () => resetCalls++ }
  let resetCalls = 0
  const instance: InkInstanceLike = {
    log,
    lastOutput: "old frame",
    lastOutputToRender: "old frame",
    lastOutputHeight: 30,
    interactive: true,
  }
  const guard = createResizeRedrawGuard(stdout)
  guard.attach(instance)
  return {
    stdout,
    written,
    instance,
    resetCalls: () => resetCalls,
    resize(cols?: number, rows?: number) {
      if (cols !== undefined) stdout.columns = cols
      if (rows !== undefined) stdout.rows = rows
      for (const listener of listeners) listener()
    },
  }
}

describe("createResizeRedrawGuard", () => {
  afterEach(() => {
    vi.useRealTimers()
    registerSettleReprintHandler(undefined)
  })

  it("anchors on a width change: blank + home, and Ink forgets the old frame", () => {
    const h = harness({ columns: 120, rows: 30 })
    h.resize(100)
    expect(h.written).toEqual([BLANK])
    expect(h.resetCalls()).toBe(1)
    expect(h.instance.lastOutput).toBe("")
    expect(h.instance.lastOutputToRender).toBe("")
    expect(h.instance.lastOutputHeight).toBe(0)
  })

  it("anchors on a height SHRINK at the same width (the boot frame leak)", () => {
    const h = harness({ columns: 120, rows: 40 })
    h.resize(undefined, 30)
    expect(h.written).toEqual([BLANK])
    expect(h.resetCalls()).toBe(1)
    expect(h.instance.lastOutputHeight).toBe(0)
  })

  it("does NOT anchor when the window only grows (no re-flow, no flicker)", () => {
    const h = harness({ columns: 120, rows: 30 })
    h.resize(undefined, 45)
    expect(h.written).toEqual([])
    expect(h.resetCalls()).toBe(0)
  })

  it("stands down for a same-size resize event (no width change, no shrink)", () => {
    const h = harness({ columns: 120, rows: 30 })
    h.resize()
    h.resize()
    expect(h.written).toEqual([])
  })

  it("anchors once per real change, not per event", () => {
    const h = harness({ columns: 120, rows: 30 })
    h.resize(100)
    h.resize(100)
    expect(h.written).toEqual([BLANK])
  })

  it("keeps the last good width so the next real change still compares against it", () => {
    const h = harness({ columns: 120, rows: 30 })
    // A geometry-less event must NOT become the new baseline: the next real
    // width still has to read as a change.
    h.stdout.columns = 0
    h.stdout.rows = 0
    h.resize()
    h.stdout.columns = 120
    h.stdout.rows = 30
    h.written.length = 0
    h.stdout.columns = 90
    h.resize()
    expect(h.written).toContain(BLANK)
  })

  it("does NOT anchor on a geometry-less event (the clone feedback loop)", () => {
    // Windows Node emits "resize" when the BUFFER scrolls, and a console
    // mid-reattach reports 0/undefined. Anchoring on those produced one
    // full-frame rewrite per repaint forever — the frame clones.
    const h = harness({ columns: 120, rows: 30 })
    h.stdout.columns = 0
    h.stdout.rows = 0
    h.resize()
    h.resize()
    h.resize()
    expect(h.written.filter((w) => w === BLANK)).toHaveLength(0)
  })

  it("does NOT anchor when the event repeats an unchanged geometry", () => {
    const h = harness({ columns: 120, rows: 30 })
    for (let i = 0; i < 5; i++) h.resize()
    expect(h.written.filter((w) => w === BLANK)).toHaveLength(0)
  })

  it("always blanks on a width shrink, even mid-drag (reflow scrolls otherwise)", () => {
    const h = harness({ columns: 120, rows: 30 })
    // A narrower window re-flows full-width rows and the surplus scrolls into
    // scrollback terminal-side — only a blank that lands first preempts it,
    // so shrinks are never throttled no matter how fast the drag.
    h.resize(118)
    h.resize(116)
    h.resize(114)
    expect(h.written).toEqual([BLANK, BLANK, BLANK])
    expect(h.instance.lastOutputHeight).toBe(0)
  })

  it("re-homes instead of blanking when only the width grew (nothing splits)", () => {
    const h = harness({ columns: 120, rows: 30 })
    h.resize(122)
    expect(h.written).toEqual([BLANK])
    // Second growth inside the throttle window: cursor home, no erase.
    h.resize(124)
    expect(h.written).toEqual([BLANK, HOME])
    expect(h.instance.lastOutputHeight).toBe(0)
  })

  it("still throttles blanks when only the height shrank (no re-flow possible)", () => {
    const h = harness({ columns: 120, rows: 40 })
    h.resize(undefined, 38)
    expect(h.written).toEqual([BLANK])
    // Second shrink inside the window: re-home only; live-fit paints already
    // fit, so there is nothing to preempt and no reason to strobe.
    h.resize(undefined, 36)
    expect(h.written).toEqual([BLANK, HOME])
  })

  it("re-anchors once the resize settles (terminal reflows after the event)", () => {
    vi.useFakeTimers()
    const h = harness({ columns: 120, rows: 30 })
    h.resize(100)
    // One anchor for the event itself…
    expect(h.written.filter((w) => w === BLANK)).toHaveLength(1)
    // …and one more after the settle window, for a buffer re-flow that
    // happened after the app was notified.
    vi.advanceTimersByTime(200)
    expect(h.written.filter((w) => w === BLANK)).toHaveLength(2)
  })

  it("blanks every step of a shrink drag, plus one settle blank", () => {
    // Real timers on purpose: the rate limit is wall-clock, and fake timers
    // fake Date.now() too. Shrink steps are never throttled; the settle timer
    // is out of scope here (covered by the settle test above).
    const h = harness({ columns: 120, rows: 30 })
    for (const w of [118, 116, 114, 112]) h.resize(w)
    expect(h.written.filter((w) => w === BLANK)).toHaveLength(4)
    expect(h.written.filter((w) => w === HOME)).toHaveLength(0)
  })

  it("logs resize decisions when NEMO_RESIZE_DEBUG=1, silent otherwise", () => {
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "resize-guard-")),
      "resize.log",
    )
    vi.stubEnv("NEMO_RESIZE_DEBUG", "1")
    vi.stubEnv("NEMO_RESIZE_LOG", tmp)
    try {
      const h = harness({ columns: 120, rows: 30 })
      h.resize(100)
      h.resize()
      const logged = fs.readFileSync(tmp, "utf8")
      // A width shrink blanks unconditionally (SHRINK), everything else that
      // anchors logs ANCHOR; both prove the decision was traced.
      expect(logged).toMatch(/ANCHOR|SHRINK/)
      expect(logged).toContain("SKIP unchanged-geometry")
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    }
    // Off by default: no file, no crash.
    const h2 = harness({ columns: 120, rows: 30 })
    h2.resize(100)
    expect(h2.written).toContain(BLANK)
  })

  it("never blanks a non-interactive or torn-down instance", () => {
    const nonInteractive = harness()
    nonInteractive.instance.interactive = false
    nonInteractive.resize(100)
    expect(nonInteractive.written).toEqual([])

    const unmounted = harness()
    unmounted.instance.isUnmounted = true
    unmounted.resize(100)
    expect(unmounted.written).toEqual([])

    const unmounting = harness()
    unmounting.instance.isUnmounting = true
    unmounting.resize(undefined, 10)
    expect(unmounting.written).toEqual([])
  })

  it("does not blank before render() has produced an instance", () => {
    const written: string[] = []
    const listeners: Array<() => void> = []
    const stdout = {
      columns: 120,
      rows: 30,
      on(_event: "resize", listener: () => void) {
        listeners.push(listener)
        return stdout
      },
      write(chunk: string) {
        written.push(chunk)
        return true
      },
    }
    createResizeRedrawGuard(stdout)
    for (const listener of listeners) listener()
    expect(written).toEqual([])
  })
})

/**
 * Geometry poll: consoles where 'resize' never fires (verified live — zero
 * events across whole-window drags, columns/rows frozen at launch size).
 * The guard refreshes Node's cache from the getWindowSize syscall and emits
 * a synthetic resize on real change, so Ink, the guard listener, and React
 * state follow the exact same path as a real event.
 */
describe("size poll (dead resize events)", () => {
  function pollHarness() {
    const written: string[] = []
    const listeners: Array<() => void> = []
    let emitted = 0
    let liveColumns = 120
    let liveRows = 30
    const stdout = {
      columns: 120,
      rows: 30,
      on(event: "resize", listener: () => void) {
        if (event === "resize") listeners.push(listener)
        return stdout
      },
      emit(event: "resize") {
        if (event === "resize") {
          emitted++
          for (const listener of listeners) listener()
        }
        return true
      },
      write(chunk: string) {
        written.push(chunk)
        return true
      },
      getWindowSize: (): [number, number] => [liveColumns, liveRows],
    }
    const log = { reset: () => {} }
    const instance: InkInstanceLike = {
      log,
      lastOutput: "old frame",
      lastOutputToRender: "old frame",
      lastOutputHeight: 30,
      interactive: true,
    }
    const guard = createResizeRedrawGuard(stdout)
    guard.attach(instance)
    return {
      stdout,
      written,
      instance,
      emitted: () => emitted,
      setLive(columns: number, rows: number) {
        liveColumns = columns
        liveRows = rows
      },
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it("emits a synthetic resize when the syscall size moves but no event arrives", () => {
    vi.useFakeTimers()
    const h = pollHarness()
    // Quiet polls: nothing changed, nothing emitted, nothing written.
    vi.advanceTimersByTime(1000)
    expect(h.emitted()).toBe(0)
    expect(h.written).toEqual([])
    // The window shrinks with zero events (the live failure). The poll sees
    // it, syncs the cache, and the synthetic event anchors like a real one.
    h.setLive(100, 25)
    vi.advanceTimersByTime(250)
    expect(h.emitted()).toBe(1)
    expect(h.stdout.columns).toBe(100)
    expect(h.stdout.rows).toBe(25)
    expect(h.written).toEqual([BLANK])
    expect(h.instance.lastOutputHeight).toBe(0)
  })

  it("stays silent without a syscall (pipes, tests) and when nothing changed", () => {
    vi.useFakeTimers()
    const h = pollHarness()
    delete (h.stdout as unknown as Record<string, unknown>).getWindowSize
    vi.advanceTimersByTime(2000)
    expect(h.emitted()).toBe(0)
    expect(h.written).toEqual([])
  })

  it("the poll stands down with the rest of the guard", () => {
    vi.useFakeTimers()
    const h = pollHarness()
    h.instance.interactive = false
    h.setLive(100, 25)
    vi.advanceTimersByTime(1000)
    expect(h.emitted()).toBe(0)
    expect(h.written).toEqual([])
  })
})

/**
 * Settle rebuild (pi's fullRender(true), ported): after a shrink the guard
 * wipes viewport AND scrollback (ED3) at settle and asks App — through the
 * settle-reprint slot — to remount Static so the transcript reprints from
 * item 0. History survives clean instead of cloned. Viewport-only residue
 * needs no rebuild (blank covers it), so growth-only settles stay quiet.
 */
describe("settle rebuild after shrink", () => {
  const ED3 = "\x1b[3J";

  function settleHarness() {
    const written: string[] = [];
    const listeners: Array<() => void> = [];
    const stdout = {
      columns: 120,
      rows: 30,
      on(event: string, listener: () => void) {
        if (event === "resize") listeners.push(listener);
        return stdout;
      },
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    };
    const instance = {
      log: { reset: () => {} },
      lastOutput: "old frame",
      lastOutputToRender: "old frame",
      lastOutputHeight: 30,
      interactive: true,
    };
    const guard = createResizeRedrawGuard(stdout);
    guard.attach(instance);
    return {
      stdout,
      written,
      fire(columns: number, rows?: number) {
        stdout.columns = columns;
        if (rows !== undefined) stdout.rows = rows;
        for (const listener of listeners) listener();
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    registerSettleReprintHandler(undefined);
  });

  it("clears scrollback and requests the reprint after a shrink settles", () => {
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(100, 30);
    // Immediate: viewport blank only (no scrollback wipe mid-drag — strobe).
    expect(h.written).toEqual(["\x1b[2J\x1b[H"]);
    expect(reprints).toEqual([]);
    // Settle (150ms quiet): viewport blank again, then scrollback clear, then
    // the reprint request. The order is load-bearing — paint before the clear
    // would be wiped, clear with no reprint would eat history.
    vi.advanceTimersByTime(200);
    expect(h.written).toEqual(["\x1b[2J\x1b[H", "\x1b[2J\x1b[H", ED3]);
    expect(reprints).toEqual(["reprint"]);
  });

  it("rebuilds the viewport but never the scrollback after a height-only shrink", () => {
    // Height shrinks re-flow nothing terminal-side, so the scrollback above is
    // undamaged: ED3 + reprint would only nuke the user's scrolled position for
    // no reason. That part of the contract is unchanged.
    //
    // What CHANGED is the settle blank. This test used to require a SECOND
    // `ESC[2J ESC[H` at settle time with no reprint behind it — which is the
    // reported black screen: the viewport was wiped and nothing was scheduled to
    // paint it back, so a height-only resize left the terminal fully black until
    // some unrelated later repaint happened to fire.
    //
    // The settle blank is now gated on the same `damageSinceSettle` condition that
    // gates the rebuild, so the two halves are atomic: wipe + refill, or nothing.
    // Re-anchoring is still correct when there IS damage, and the scrollback is
    // still preserved here, which is what the narrowing of the latch was for.
    vi.useFakeTimers()
    const reprints: string[] = []
    registerSettleReprintHandler(() => reprints.push("reprint"))
    const h = settleHarness()
    h.fire(120, 24)
    // The event-time anchor is unconditional: the resize itself must re-seat the
    // frame before anything can scroll.
    expect(h.written).toEqual(["\x1b[2J\x1b[H"])
    vi.advanceTimersByTime(200)
    // No second blank, because nothing was damaged — so nothing is left blank.
    expect(h.written).toEqual(["\x1b[2J\x1b[H"])
    expect(h.written.every((w) => w !== ED3)).toBe(true)
    expect(reprints).toEqual([])
  })

  it("stays quiet when only growth settled (nothing scrolled, nothing to rebuild)", () => {
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(140, 30);
    h.fire(150, 30);
    vi.advanceTimersByTime(200);
    // Viewport blanks only (growth is reflow-safe); no scrollback wipe, no
    // reprint — the history was never in danger.
    expect(h.written.every((w) => w !== ED3)).toBe(true);
    expect(reprints).toEqual([]);
  });

  it("rebuilds after a big growth jump (maximise outruns the window)", () => {
    // Slow stretch repaints inside a tracking window and stays clean; a
    // maximise jumps dozens of cells at once while the repaint outruns the
    // window manager — the new-size frame paints into the still-old window
    // and the overflow scrolls into scrollback before the window catches up.
    // The settle then wipes viewport+scrollback and reprints, same as shrink.
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(240, 60);
    // Immediate: viewport blank (throttle window is cold on the first jump).
    expect(h.written).toEqual(["\x1b[2J\x1b[H"]);
    expect(reprints).toEqual([]);
    // Settle: blank again, scrollback clear, reprint — the burst's overflow
    // rows are unreachable any other way.
    vi.advanceTimersByTime(200);
    expect(h.written).toEqual(["\x1b[2J\x1b[H", "\x1b[2J\x1b[H", ED3]);
    expect(reprints).toEqual(["reprint"]);
  });

  it("rebuilds after a rows-only big jump (vertical maximise has no width signal)", () => {
    // Height-only growth used to take the quiet path unconditionally — a
    // vertical maximise overflowed rows with no rebuild ever scheduled. No
    // immediate blank (nothing re-flowed; the quiet-growth contract stands),
    // then the settle wipes + reprints once quiet.
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(120, 60);
    expect(h.written).toEqual([]);
    expect(reprints).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(h.written).toEqual(["\x1b[2J\x1b[H", ED3]);
    expect(reprints).toEqual(["reprint"]);
  });

  it("small growth stays quiet (drags never wipe the scrolled position)", () => {
    // A few cells per event repaint inside a tracking window: blanking the
    // viewport is already more than enough, and a scrollback wipe would nuke
    // the user's scrolled-back reading position for no reason.
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(124, 32);
    expect(h.written).toEqual(["\x1b[2J\x1b[H"]);
    vi.advanceTimersByTime(200);
    expect(h.written).toEqual(["\x1b[2J\x1b[H"]);
    expect(h.written.every((w) => w !== ED3)).toBe(true);
    expect(reprints).toEqual([]);
  });

  it("minimise-then-restore stays quiet (refused sizes keep the baseline)", () => {
    // Minimise reports 0x0: refused without moving baselines, so the restore
    // reads as a small delta — never a jump — and no wipe eats the history
    // the user scrolled back to before minimising.
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = settleHarness();
    h.fire(0, 0);
    h.fire(120, 30);
    vi.advanceTimersByTime(200);
    expect(h.written).toEqual([]);
    expect(reprints).toEqual([]);
  });

  it("never wipes scrollback without a live owner (would eat shell history)", () => {
    vi.useFakeTimers();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const written: string[] = [];
    const listeners: Array<() => void> = [];
    const stdout = {
      columns: 120,
      rows: 30,
      on(event: string, listener: () => void) {
        if (event === "resize") listeners.push(listener);
        return stdout;
      },
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    };
    // Never attached: no instance, no writes at all.
    createResizeRedrawGuard(stdout);
    expect(written).toEqual([]);
    expect(reprints).toEqual([]);
  });
});

/**
 * Turn-end full re-render (streaming-clone fix): a grown turn stacked
 * intermediate live frames terminal-side, so App calls requestFullRender()
 * when it ends. Same bytes as the settle rebuild (viewport blank + home,
 * scrollback clear, transcript reprint from item 0) — order load-bearing,
 * wipe and reprint atomically paired (a remount with no wipe would reprint
 * history UNDER the stale frames: clones, exactly what this kills).
 */
describe("turn-end fullRender", () => {
  const ED3 = "\x1b[3J";

  afterEach(() => {
    vi.useRealTimers();
    registerSettleReprintHandler(undefined);
    registerFullRenderHandler(undefined);
  });

  it("wipes viewport+scrollback and reprints, in load-bearing order", () => {
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = harness();
    expect(requestFullRender()).toBe(true);
    // Viewport blank first, scrollback clear second, reprint requested last:
    // a reprint before the clear would be wiped, a clear with no reprint
    // would eat history.
    expect(h.written).toEqual([BLANK, ED3]);
    expect(reprints).toEqual(["reprint"]);
    // Ink forgot the wiped frame: the reprint paints whole, never a
    // stale-count erase over the clean screen.
    expect(h.instance.lastOutput).toBe("");
    expect(h.instance.lastOutputHeight).toBe(0);
    expect(h.resetCalls()).toBeGreaterThan(0);
  });

  it("stands down with no attached instance (tests, pipes): no bytes, no reprint", () => {
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const written: string[] = [];
    const stdout = {
      columns: 120,
      rows: 30,
      on() {
        return stdout;
      },
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    };
    createResizeRedrawGuard(stdout);
    expect(requestFullRender()).toBe(false);
    expect(written).toEqual([]);
    expect(reprints).toEqual([]);
  });

  it("stands down when the instance is non-interactive or torn down", () => {
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const h = harness();
    h.instance.interactive = false;
    expect(requestFullRender()).toBe(false);
    h.instance.interactive = true;
    h.instance.isUnmounted = true;
    expect(requestFullRender()).toBe(false);
    h.instance.isUnmounted = undefined;
    h.instance.isUnmounting = true;
    expect(requestFullRender()).toBe(false);
    expect(h.written).toEqual([]);
    expect(reprints).toEqual([]);
  });

  it("latest guard owns the single slot (never two writers)", () => {
    const first = harness();
    const second = harness();
    const reprints: string[] = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    expect(requestFullRender()).toBe(true);
    expect(second.written).toEqual([BLANK, ED3]);
    expect(first.written).toEqual([]);
    expect(reprints).toEqual(["reprint"]);
  });
});

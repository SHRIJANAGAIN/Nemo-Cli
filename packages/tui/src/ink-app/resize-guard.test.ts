/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
import { registerSettleReprintHandler } from "./app-bootstrap.js"

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

  it("logs resize decisions when TRAYAMBAK_RESIZE_DEBUG=1, silent otherwise", () => {
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "resize-guard-")),
      "resize.log",
    )
    vi.stubEnv("TRAYAMBAK_RESIZE_DEBUG", "1")
    vi.stubEnv("TRAYAMBAK_RESIZE_LOG", tmp)
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
    const written = [];
    const listeners = [];
    const stdout = {
      columns: 120,
      rows: 30,
      on(event, listener) {
        if (event === "resize") listeners.push(listener);
        return stdout;
      },
      write(chunk) {
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
      fire(columns, rows) {
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
    const reprints = [];
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

  it("stays quiet when only growth settled (nothing scrolled, nothing to rebuild)", () => {
    vi.useFakeTimers();
    const reprints = [];
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

  it("never wipes scrollback without a live owner (would eat shell history)", () => {
    vi.useFakeTimers();
    const reprints = [];
    registerSettleReprintHandler(() => reprints.push("reprint"));
    const written = [];
    const listeners = [];
    const stdout = {
      columns: 120,
      rows: 30,
      on(event, listener) {
        if (event === "resize") listeners.push(listener);
        return stdout;
      },
      write(chunk) {
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

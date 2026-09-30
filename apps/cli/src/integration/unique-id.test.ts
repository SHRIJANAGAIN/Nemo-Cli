/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, vi, afterEach } from "vitest"
import { uniqueId } from "./unique-id.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("uniqueId", () => {
  it("returns the minted id untouched when nothing is taken (format must not drift)", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"))
    expect(uniqueId("plan-mcx1k2")).toBe("plan-mcx1k2")
  })

  it("suffixes on the first collision", () => {
    expect(uniqueId("board-1754049600000", ["board-1754049600000"])).toBe("board-1754049600000-2")
  })

  it("keeps counting past already-taken suffixes instead of reusing one", () => {
    const taken = ["step-abc", "step-abc-2", "step-abc-3"]
    expect(uniqueId("step-abc", taken)).toBe("step-abc-4")
  })

  it("accepts a Set as well as an array (callers hold maps' key iterators)", () => {
    expect(uniqueId("plan-1", new Set(["plan-1"]))).toBe("plan-1-2")
    expect(uniqueId("plan-2", new Set(["plan-1"]))).toBe("plan-2")
  })

  it("treats an empty/missing taken-set as no collision", () => {
    expect(uniqueId("cell-9")).toBe("cell-9")
    expect(uniqueId("cell-9", [])).toBe("cell-9")
  })

  it("does not mutate the collection it was handed", () => {
    const taken: string[] = ["plan-1"]
    uniqueId("plan-1", taken)
    expect(taken).toEqual(["plan-1"])
  })
})

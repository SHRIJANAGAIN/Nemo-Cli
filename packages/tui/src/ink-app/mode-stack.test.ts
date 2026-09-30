/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import {
  MODE_CYCLE,
  cycleMode,
  enterMode,
  exitMode,
  formatModeStack,
  isPermissionMode,
  type ModeStackState,
} from "./mode-stack.js"
import type { PermissionMode } from "./types.js"

const s = (current: PermissionMode, stack: PermissionMode[] = []): ModeStackState => ({
  current,
  stack,
})

describe("MODE_CYCLE", () => {
  it("keeps the original five-mode order", () => {
    expect(MODE_CYCLE).toEqual(["read-only", "plan", "ask", "auto-approve", "full-access"])
  })
})

describe("cycleMode", () => {
  it("advances linearly and wraps", () => {
    expect(cycleMode(s("read-only")).current).toBe("plan")
    expect(cycleMode(s("ask")).current).toBe("auto-approve")
    expect(cycleMode(s("auto-approve")).current).toBe("full-access")
    expect(cycleMode(s("full-access")).current).toBe("read-only")
  })

  it("pushes the current mode when entering plan", () => {
    const next = cycleMode(s("read-only"))
    expect(next.current).toBe("plan")
    expect(next.stack).toEqual(["read-only"])
  })

  it("consumes the frame when leaving plan by cycling", () => {
    const next = cycleMode(s("plan", ["read-only"]))
    expect(next.current).toBe("ask")
    expect(next.stack).toEqual([])
  })

  it("leaves the stack alone between non-plan modes", () => {
    expect(cycleMode(s("ask", ["read-only"]))).toEqual({
      current: "auto-approve",
      stack: ["read-only"],
    })
  })

  it("restarts at read-only for an unknown mode (original behaviour)", () => {
    expect(cycleMode(s("banana" as PermissionMode)).current).toBe("read-only")
  })
})

describe("enterMode", () => {
  it("no-ops for the same mode (identity)", () => {
    const st = s("ask", ["read-only"])
    expect(enterMode(st, "ask")).toBe(st)
  })

  it("pushes when entering plan", () => {
    expect(enterMode(s("full-access"), "plan")).toEqual({
      current: "plan",
      stack: ["full-access"],
    })
  })

  it("consumes the frame when leaving plan explicitly", () => {
    expect(enterMode(s("plan", ["ask"]), "read-only")).toEqual({
      current: "read-only",
      stack: [],
    })
  })

  it("keeps the stack on unrelated switches", () => {
    expect(enterMode(s("ask", ["read-only"]), "auto-approve")).toEqual({
      current: "auto-approve",
      stack: ["read-only"],
    })
  })
})

describe("exitMode", () => {
  it("is a no-op outside plan mode (identity)", () => {
    const st = s("ask", ["read-only"])
    expect(exitMode(st)).toBe(st)
  })

  it("restores the pushed mode (LIFO)", () => {
    expect(exitMode(s("plan", ["read-only", "full-access"]))).toEqual({
      current: "full-access",
      stack: ["read-only"],
    })
  })

  it("defaults to ask when the stack is empty", () => {
    expect(exitMode(s("plan"))).toEqual({ current: "ask", stack: [] })
  })
})

describe("formatModeStack", () => {
  it("returns null with no frames", () => {
    expect(formatModeStack(s("ask"))).toBeNull()
  })

  it("joins the breadcrumb", () => {
    expect(formatModeStack(s("plan", ["ask"]))).toBe("ask → plan")
    expect(formatModeStack(s("ask", ["read-only", "plan"]))).toBe("read-only → plan → ask")
  })
})

describe("isPermissionMode", () => {
  it("accepts exactly the five bootable modes", () => {
    for (const m of ["read-only", "plan", "ask", "auto-approve", "full-access"]) {
      expect(isPermissionMode(m)).toBe(true)
    }
  })

  it("rejects garbage, wrong case, and legacy names", () => {
    for (const v of [undefined, null, "", "ASK", "auto", "full", "yolo", 42, {}]) {
      expect(isPermissionMode(v)).toBe(false)
    }
  })
})

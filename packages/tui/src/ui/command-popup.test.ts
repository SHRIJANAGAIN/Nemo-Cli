/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { CommandPopup } from "./command-popup.js"
import type { CommandItem } from "./command-popup.js"

const ITEMS: CommandItem[] = [
  { name: "Alpha", description: "first command" },
  { name: "Beta", description: "second command", hidden: true },
  { name: "Gamma", description: "third command" },
  { name: "Delta", description: "fourth command" },
  { name: "Epsilon", description: "fifth command" },
]

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "")

describe("CommandPopup.render", () => {
  it("hides hidden items and pads names to a fixed width", () => {
    const p = new CommandPopup()
    const lines = p.render(ITEMS, "", { width: 80, height: 10 }, false)
    expect(lines.length).toBe(4) // Beta excluded
    expect(lines[0]).toBe("  " + "Alpha".padEnd(24) + " \x1b[2mfirst command\x1b[0m")
    expect(lines.every((l) => !plain(l).includes("Beta"))).toBe(true)
    // Unfocused rendering never uses the selection marker.
    expect(lines.every((l) => plain(l).startsWith("  "))).toBe(true)
  })

  it("filters case-insensitively on name and highlights matches", () => {
    const p = new CommandPopup()
    const lines = p.render(ITEMS, "alp", { width: 80, height: 10 }, false)
    expect(lines.length).toBe(1)
    expect(plain(lines[0]!)).toContain("Alpha")
    expect(lines[0]).toContain("\x1b[1;38;5;33m")
    expect(p.getSelectedItem()?.name).toBe("Alpha")
  })

  it("matches on the description when the name does not match", () => {
    const p = new CommandPopup()
    const lines = p.render(ITEMS, "fourth", { width: 80, height: 10 }, false)
    expect(lines.length).toBe(1)
    expect(plain(lines[0]!)).toContain("Delta")
    // Name contributes no highlight indices, so the name stays plain.
    expect(lines[0]).not.toContain("\x1b[1;38;5;33m")
  })

  it("returns a placeholder line when nothing matches", () => {
    const p = new CommandPopup()
    const lines = p.render(ITEMS, "zzz", { width: 80, height: 10 }, true)
    expect(lines).toEqual(["\x1b[2mNo matches\x1b[0m"])
    expect(p.getSelectedItem()).toBeUndefined()
    // Navigation is a no-op on an empty list.
    p.moveUp()
    p.moveDown()
    expect(p.getSelectedIndex()).toBe(0)
  })

  it("marks the selected row only when focused", () => {
    const p = new CommandPopup()
    const focused = p.render(ITEMS, "", { width: 80, height: 10 }, true)
    expect(focused[0]!.startsWith("\x1b[47m\x1b[30m> ")).toBe(true)
    expect(focused[1]!.startsWith("  ")).toBe(true)

    const unfocused = p.render(ITEMS, "", { width: 80, height: 10 }, false)
    expect(unfocused[0]!.startsWith("  ")).toBe(true)
    expect(unfocused[0]).not.toContain("\x1b[47m")
  })

  it("scrolls the window to follow selection beyond the area height", () => {
    const p = new CommandPopup()
    const lines = p.render(ITEMS, "", { width: 80, height: 2 }, true)
    expect(lines.length).toBe(2)
    expect(plain(lines[0]!).startsWith("> Alpha")).toBe(true)

    p.moveDown()
    p.moveDown()
    p.moveDown() // selectedIndex 3 (4 visible items) -> scrolls down
    const scrolled = p.render(ITEMS, "", { width: 80, height: 2 }, true)
    expect(scrolled.length).toBe(2)
    expect(p.getSelectedIndex()).toBe(3)
    expect(plain(scrolled[1]!).startsWith("> Epsilon")).toBe(true)

    p.moveUp()
    p.moveUp() // selectedIndex 1 -> scrolls back up
    const back = p.render(ITEMS, "", { width: 80, height: 2 }, true)
    expect(p.getSelectedIndex()).toBe(1)
    expect(plain(back[0]!).startsWith("> Gamma")).toBe(true)
    expect(plain(back[1]!)).toContain("Delta")
  })

  it("clamps the selection when the query shrinks the list", () => {
    const p = new CommandPopup()
    p.render(ITEMS, "", { width: 80, height: 10 }, true)
    p.moveDown()
    p.moveDown()
    p.moveDown() // selectedIndex 3
    expect(p.getSelectedIndex()).toBe(3)

    const lines = p.render(ITEMS, "alp", { width: 80, height: 10 }, true)
    expect(lines.length).toBe(1)
    expect(p.getSelectedIndex()).toBe(0)
    expect(p.getSelectedItem()?.name).toBe("Alpha")
  })

  it("clamps to index 0 when the list becomes empty", () => {
    const p = new CommandPopup()
    p.render(ITEMS, "", { width: 80, height: 10 }, true)
    p.moveDown()
    p.moveDown()
    p.moveDown()
    p.render(ITEMS, "zzz", { width: 80, height: 10 }, true)
    expect(p.getSelectedIndex()).toBe(0)
    expect(p.getSelectedItem()).toBeUndefined()
  })
})

describe("CommandPopup navigation", () => {
  it("wraps around at both ends", () => {
    const p = new CommandPopup()
    p.render(ITEMS, "", { width: 80, height: 10 }, true)
    expect(p.getSelectedItem()?.name).toBe("Alpha")

    p.moveUp() // wraps to last
    expect(p.getSelectedIndex()).toBe(3)
    expect(p.getSelectedItem()?.name).toBe("Epsilon")

    p.moveDown() // wraps back to first
    expect(p.getSelectedIndex()).toBe(0)
    expect(p.getSelectedItem()?.name).toBe("Alpha")
  })

  it("is inert before the first render", () => {
    const p = new CommandPopup()
    p.moveUp()
    p.moveDown()
    expect(p.getSelectedIndex()).toBe(0)
    expect(p.getSelectedItem()).toBeUndefined()
  })
})

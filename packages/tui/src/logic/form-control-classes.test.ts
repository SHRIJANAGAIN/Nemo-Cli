/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  chatInputPillButtonClassName,
  formControlButtonClassName,
  formControlFieldClassName,
  formControlFilterTriggerClassName,
  formControlHeightClassName,
  formControlMultilineFieldClassName,
  formControlShellClassName,
  formControlSettingsFieldClassName,
} from "./form-control-classes.js"
import { cn } from "./utils.js"

const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean)

/** The composed constants must keep the semantic pieces their doc comments promise. */
const expectTokensIn = (composed: string, ...pieces: string[]): void => {
  for (const piece of pieces) {
    for (const token of tokens(piece)) {
      expect(composed, `missing token: ${token}`).toContain(token)
    }
  }
}

describe("form-control-classes composition", () => {
  it("field class composes height, radius, border, surface, transition, focus and disabled pieces", () => {
    expectTokensIn(
      formControlFieldClassName,
      formControlHeightClassName,
      "rounded-lg",
      "border-[var(--oh-border)]",
      "bg-base-secondary",
      "transition-[background-color,border-color,box-shadow,opacity]",
      "duration-75",
      "motion-reduce:transition-none",
      "focus:border-white/40",
      "focus:ring-white/20",
      "focus:outline-none",
      "disabled:cursor-not-allowed",
      "disabled:opacity-60",
    )
    // Native inputs fill their row and use the shared text/placeholder style.
    expect(formControlFieldClassName).toContain("w-full")
    expect(formControlFieldClassName).toContain("placeholder:text-tertiary-alt")
  })

  it("multiline field keeps border/focus styling but drops the fixed 36px height", () => {
    expect(formControlMultilineFieldClassName).not.toContain("h-9")
    expect(formControlMultilineFieldClassName).not.toContain("min-h-9")
    expect(formControlMultilineFieldClassName).toContain("py-2")
    expectTokensIn(
      formControlMultilineFieldClassName,
      "rounded-lg",
      "border-[var(--oh-border)]",
      "focus:border-white/40",
      "disabled:opacity-60",
    )
  })

  it("settings field layers italic placeholders and the HeroUI wrapper override onto the field class", () => {
    expect(formControlSettingsFieldClassName).toContain("placeholder:italic")
    expect(formControlSettingsFieldClassName).toContain(
      "!transition-[background-color,border-color,box-shadow,opacity]",
    )
    expect(formControlSettingsFieldClassName).toContain("h-9")
    expect(formControlSettingsFieldClassName).toContain("focus:border-white/40")
  })

  it("combobox shell listens to focus-within, not focus (borderless nested input)", () => {
    expectTokensIn(formControlShellClassName, formControlHeightClassName, "rounded-lg", "bg-base-secondary")
    expect(formControlShellClassName).toContain("focus-within:border-white/40")
    expect(formControlShellClassName).toContain("focus-within:ring-white/20")
    // The bare-input focus styles belong to the field class, not the shell.
    expect(formControlShellClassName).not.toContain("focus:border-white/40")
  })

  it("button and filter trigger share height, radius and disabled affordances", () => {
    expectTokensIn(formControlButtonClassName, formControlHeightClassName, "rounded-lg", "inline-flex", "w-fit")
    expect(formControlButtonClassName).toContain("disabled:cursor-not-allowed")
    expect(formControlFilterTriggerClassName).toContain("bg-base-secondary")
    expect(formControlFilterTriggerClassName).toContain("border-[var(--oh-border)]")
    expect(formControlFilterTriggerClassName).toContain("inline-flex")
  })

  it("chat input pill trigger combines the pill shell with hover affordances", () => {
    expect(chatInputPillButtonClassName).toContain("rounded-[100px]")
    expect(chatInputPillButtonClassName).toContain("text-[var(--oh-muted)]")
    expect(chatInputPillButtonClassName).toContain("hover:bg-white/10")
    expect(chatInputPillButtonClassName).toContain("duration-75")
  })

  it("every composed constant is already conflict-normalized (re-merging is a no-op)", () => {
    for (const composed of [
      formControlFieldClassName,
      formControlSettingsFieldClassName,
      formControlMultilineFieldClassName,
      formControlShellClassName,
      formControlButtonClassName,
      formControlFilterTriggerClassName,
      chatInputPillButtonClassName,
    ]) {
      const parts = tokens(composed)
      expect(new Set(parts).size, composed).toBe(parts.length)
      expect(cn(composed)).toBe(composed)
    }
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Runtime keymap: which chord fires which action, honouring user overrides.
 *
 * `keybindings.ts` already declared 44 action ids and shipped a
 * `createKeybindingRegistry`, but nothing in production ever called it — the
 * TUI dispatched every chord with hand-written `key.ctrl && input === "z"`
 * comparisons scattered across four components. So the registry was
 * documentation, and `/keymap` printed a fixed table the user could not change.
 * This module is what makes the declared actions real.
 *
 * Two deliberate constraints:
 *
 *  1. **Escape hatches are not rebindable.** `tui.approval.deny`,
 *     `tui.approval.approve`, and the two cancel actions are pinned. A rebind
 *     that is ambiguous, or that a user sets to a chord their terminal never
 *     emits, must not be able to leave an approval prompt with no working
 *     "no". Losing deny is losing the sandbox; that is not a preference.
 *
 *  2. **Unknown actions are dropped, not merged.** A typo'd override key is
 *     ignored rather than silently rebound to something unintended.
 */

import type { Key } from "ink"
import { DEFAULT_KEYBINDINGS, GLOBAL_SHORTCUTS, type GlobalShortcut, type KeybindingsConfig } from "./keybindings.js"

/**
 * Actions a user may NOT rebind, with the reason each is pinned. Surfaced
 * verbatim by `/keymap` so the refusal is legible rather than mysterious.
 */
export const LOCKED_ACTIONS: Readonly<Record<string, string>> = {
  "tui.approval.approve": "pinned: the approval path is a security decision, not a preference",
  "tui.approval.deny":
    "pinned: Escape denies above the composer guard, so 'no' is unconditional — a rebind could remove it",
  "tui.approval.approveAlways": "pinned: same decision surface as approve",
  "tui.approval.approveSession": "pinned: same decision surface as approve",
  "tui.approval.denyAlways": "pinned: same decision surface as deny",
  "tui.input.cancel": "pinned so a bad rebind can never trap you in a prompt",
  "tui.select.cancel": "pinned so a bad rebind can never trap you in a dialog",
}

/**
 * Canonical form of a single chord: lowercase, no whitespace, no stray dashes.
 *
 * Whitespace is stripped outright rather than collapsed because `toKeyId`
 * emits `ctrl+j` with no spaces — collapsing to `ctrl + j` instead would mean a
 * user who writes `"ctrl + j"` in config gets a binding that silently never
 * fires. Leader sequences (`"ctrl+k p"`) contain real whitespace, so they are
 * rejected rather than mangled into `ctrl+kp`; see `Keymap` for why this module
 * does not support them.
 */
export function normalizeChord(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^-+|-+$/g, "")
}

/** True when a chord string encodes more than one keypress (a leader table). */
export function isChordSequence(raw: string): boolean {
  // Whitespace hugging "+" is separator padding ("ctrl + j"); whitespace
  // anywhere else separates two keypresses ("ctrl+k p"). Collapsing the
  // "+"-adjacent padding first is what tells those two apart.
  return /\s/.test(raw.trim().replace(/\s*\+\s*/g, "+"))
}

/**
 * Canonical KeyId for an Ink `(input, key)` pair, or undefined when the pair
 * carries no meaningful key (a bare multi-byte paste chunk, say).
 *
 * Ink hands the component a decoded `input` plus a modifier object rather than
 * raw terminal bytes, so this is the inverse of `parseKey`. Getting it wrong is
 * silent — a chord simply never fires — which is why every branch is pinned by a
 * test instead of being left to the modifier heuristics.
 */
export function toKeyId(input: string, key: Key): string | undefined {
  // Named keys first: Ink reports `input` as a control character for these
  // (e.g. "\r" for Enter), so inspecting `input` before these would misread them.
  // Modifiers are inspected for named keys too: the declared defaults include
  // alt+backspace / alt+left / ctrl+home / ctrl+end, and returning the bare
  // name made alt+backspace collapse onto the plain "backspace" chord — the
  // key fired the WRONG action, and home/end could never be produced at all.
  const mods: string[] = []
  if (key.ctrl) mods.push("ctrl")
  if (key.meta) mods.push("alt")
  const named = (name: string): string => (mods.length > 0 ? `${mods.join("+")}+${name}` : name)
  if (key.return) return named("enter")
  if (key.escape) return named("escape")
  if (key.upArrow) return named("up")
  if (key.downArrow) return named("down")
  if (key.leftArrow) return named("left")
  if (key.rightArrow) return named("right")
  if (key.backspace) return named("backspace")
  // Ink builds these two flags from a single `keypress.name` string
  // (`use-input.js`: `backspace: name === 'backspace'`, `delete: name === 'delete'`),
  // so they are mutually exclusive — no both-flags branch is needed.
  if (key.delete) return named("delete")
  // Lowercase to match `normalizeChord`, or a config entry for "pagedown" could
  // never match what we emit here.
  if (key.pageDown) return named("pagedown")
  if (key.pageUp) return named("pageup")
  if (key.home) return named("home")
  if (key.end) return named("end")
  if (key.tab) return key.shift ? "shift+tab" : "tab"

  // A multi-character chunk is paste content, never a chord. Letting it fall
  // through would let a pasted "ctrl+z" string fire the undo handler.
  if (input.length !== 1) return undefined

  const ch = input.toLowerCase()
  // `mods` carries the ctrl/alt flags collected above; shift only applies to
  // letters (an uppercase input arrives with shift held — fold it back to the
  // base letter so "ctrl+shift+z" and a typed "Z" cannot both claim one action).
  if (key.shift && ch >= "a" && ch <= "z") mods.push("shift")
  return [...mods, ch].join("+")
}

export interface KeymapOptions {
  /** User overrides: action -> chords. Unknown/locked entries are ignored. */
  overrides?: Record<string, string[]>
  /** Defaults to DEFAULT_KEYBINDINGS. */
  defaults?: KeybindingsConfig
}

export interface RejectedOverride {
  action: string
  chord: string
  reason: "unknown-action" | "locked-action" | "unsupported-chord"
}

export class Keymap {
  private readonly effective = new Map<string, string[]>()
  readonly rejected: RejectedOverride[] = []

  constructor(options: KeymapOptions = {}) {
    const defaults = options.defaults ?? DEFAULT_KEYBINDINGS
    for (const [action, keys] of Object.entries(defaults)) {
      this.effective.set(action, keys.map(normalizeChord))
    }

    for (const [action, chords] of Object.entries(options.overrides ?? {})) {
      if (!this.effective.has(action)) {
        for (const chord of chords)
          this.rejected.push({ action, chord: normalizeChord(chord), reason: "unknown-action" })
        continue
      }
      if (LOCKED_ACTIONS[action]) {
        for (const chord of chords)
          this.rejected.push({ action, chord: normalizeChord(chord), reason: "locked-action" })
        continue
      }
      const accepted: string[] = []
      for (const chord of chords) {
        // A leader table ("ctrl+k p") is two keypresses, not one chord. Stripping
        // its whitespace would produce "ctrl+kp", a binding that silently never
        // fires — so it is reported back instead.
        if (isChordSequence(chord)) {
          this.rejected.push({ action, chord: chord.trim(), reason: "unsupported-chord" })
          continue
        }
        const normalized = normalizeChord(chord)
        if (normalized.length > 0) accepted.push(normalized)
      }
      // An override that resolves to nothing would silently disable the action,
      // leaving the user with no key for it at all. Refusing to bind nothing is
      // the only safe reading of "unbind this".
      if (accepted.length === 0) continue
      this.effective.set(action, accepted)
    }
  }

  /** Chords bound to an action; empty when the action is unknown. */
  keysFor(action: string): string[] {
    return this.effective.get(action) ?? []
  }

  /** True when this key event fires the action. */
  matches(action: string, keyId: string | undefined): boolean {
    if (keyId === undefined) return false
    const chords = this.effective.get(action)
    if (!chords) return false
    return chords.includes(keyId)
  }

  /** Convenience: normalise an Ink pair and test it in one step. */
  matchesInput(action: string, input: string, key: Key): boolean {
    return this.matches(action, toKeyId(input, key))
  }

  /** Every action whose chord set differs from the defaults. */
  overriddenActions(): string[] {
    const out: string[] = []
    for (const [action, keys] of this.effective) {
      const base = DEFAULT_KEYBINDINGS[action]
      if (!base || base.map(normalizeChord).join(",") !== keys.join(",")) out.push(action)
    }
    return out
  }

  /**
   * The chord to SHOW for an action: the user's if rebound, else the default.
   *
   * Returns undefined for an action with no default, so a caller rendering a
   * table cannot silently print an empty cell where a key should be.
   */
  displayChord(action: string): string | undefined {
    const keys = this.effective.get(action)
    return keys && keys.length > 0 ? keys[0] : undefined
  }

  /**
   * Human-readable map: action -> chords, for `/keymap`.
   *
   * Rendering the EFFECTIVE map rather than the static table is the whole point
   * of the feature — a keymap screen that ignores your overrides is worse than
   * no keymap screen, because it actively lies.
   */
  describe(): string[] {
    return [...this.effective.entries()]
      .filter(([, keys]) => keys.length > 0)
      .map(([action, keys]) => `${action} ${keys.join(", ")}${LOCKED_ACTIONS[action] ? " (pinned)" : ""}`)
  }
}

/**
 * Render the /keymap body from the EFFECTIVE bindings, not the shipped table.
 *
 * A keymap screen that ignores your overrides is worse than none at all: it
 * confidently prints "ctrl+p — command palette" after you remapped it, so you
 * trust a lie. Rebound chords are shown as `new (was old)`, and rejected
 * overrides are appended so a refused or typo'd entry is visible instead of
 * vanishing.
 */
export function formatEffectiveKeymapMessage(
  keymap: Keymap,
  shortcuts: readonly GlobalShortcut[] = GLOBAL_SHORTCUTS,
): string {
  const rendered = shortcuts.map((s) => {
    if (!s.action) return `${s.keys} ${s.label}`
    const shown = keymap.displayChord(s.action)
    if (shown === undefined || shown === normalizeChord(s.keys)) return `${s.keys} ${s.label}`
    return `${shown} ${s.label} (was ${s.keys})`
  })
  const parts = [rendered.join("  ")]
  for (const r of keymap.rejected) {
    parts.push(`ignored ${r.action} = ${r.chord} (${r.reason})`)
  }
  return parts.join("\n")
}

/** The process-wide keymap, built once from config overrides. */
let active: Keymap = new Keymap()

export function getKeymap(): Keymap {
  return active
}

/** Install a keymap built from user overrides. */
export function setKeymap(overrides: Record<string, string[]> | undefined): Keymap {
  active = new Keymap(overrides ? { overrides } : {})
  return active
}

/** Restore defaults (tests, and `/keymap reset`). */
export function resetKeymap(): void {
  active = new Keymap()
}

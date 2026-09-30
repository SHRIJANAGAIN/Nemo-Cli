/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Byte-level stdin sanitizer sitting between the terminal and Ink's input
 * parser ("hey mera question to sent hua hi nahi" — input must ALWAYS be
 * accepted and Enter must ALWAYS submit).
 *
 * Verified failure modes (scripts/smoke-enter-ui.mjs, pre-fix run):
 *  1. kitty keypad-Enter `\x1b[57414u` → Ink maps name='kpenter', which is
 *     neither key.return nor printable → the keystroke is dropped silently
 *     and the draft never submits.
 *  2. Application-keypad Enter `\x1bOM` → Ink finds no name, strips ESC and
 *     replays "O","M" as typed text ("hey" becomes "heyOM", Enter lost).
 *  3. A bracketed-paste start `\x1b[200~` with no end marker (truncated or
 *     buggy terminal write) → Ink parks ALL subsequent input in its paste
 *     buffer forever (input-parser.js holds pending past pasteStart): typing
 *     can keep rendering from the ref, but Enter never reaches the composer
 *     again — exactly the reported "question never sent, buffer stuck".
 *
 * Strategy — normalise the two exotic Enter byte-shapes to a plain CR, and
 * own bracketed-paste pairing here so Ink only ever sees complete
 * `200~…201~` pairs (its paste pipeline / usePaste then works as designed):
 *  - start+end in one chunk        → forwarded verbatim
 *  - pair split across chunks      → reassembled before forwarding
 *  - start with no end             → body held, then released as PLAIN
 *    input (markers stripped) after `holdMs` of quiet, so a stray marker
 *    can never hostage the stream
 *  - trailing marker fragment      → briefly held so a pair boundary that
 *    straddles a chunk split is still recognised; truncated `…200`/`…201`
 *    markers are dropped (Ink would hold/park them), everything else
 *    (lone ESC, split CSI…) is released untouched for Ink's own escape
 *    handling
 *  - lone end marker               → stripped (Ink would type "…201~")
 */

import { PassThrough } from "node:stream"
import { emitMouseScroll } from "./mouse-input.js"

export const PASTE_START = "\x1b[200~"
export const PASTE_END = "\x1b[201~"

/** Quiet period before a stray paste body is released as plain input. */
const HOLD_MS = 150
/** Quiet period for a trailing marker fragment (chunk-split boundary). */
const PARTIAL_MS = 30

/** Exotic Enter byte-shapes → plain CR (see module doc for proof). */
const ENTER_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["\x1b[57414u", "\r"], // kitty keyboard-protocol keypad Enter
  ["\x1bOM", "\r"], // DEC application-keypad Enter
]

/** Idempotent, regex-free (no lastIndex surprises) Enter normalisation. */
export const rewriteEnters = (bytes: string): string => {
  let out = bytes
  for (const [from, to] of ENTER_REWRITES) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return out
}

/** Remove every paste marker (used when releasing a stray body as input). */
const stripPasteMarkers = (s: string): string => s.split(PASTE_START).join("").split(PASTE_END).join("")

/** Longest proper prefix of a paste marker that `s` ends with ("" if none). */
const trailingMarkerPrefix = (s: string): string => {
  for (let k = Math.min(PASTE_START.length - 1, s.length); k >= 1; k--) {
    if (s.endsWith(PASTE_START.slice(0, k)) || s.endsWith(PASTE_END.slice(0, k))) {
      return s.slice(s.length - k)
    }
  }
  return ""
}

export interface StdinSanitizerOptions {
  /** Quiet ms before a stray paste body releases as plain input. */
  holdMs?: number
  /** Quiet ms before a trailing marker fragment resolves. */
  partialMs?: number
  /** Receives bytes to forward when a hold/partial timer fires. */
  onFlush?: (bytes: string) => void
}

/**
 * Pure state machine over raw stdin chunks: `push()` returns the bytes to
 * forward to Ink right now (possibly ""), timers release held bytes via
 * `flushHeld()`/`flushPartial()` (also public for deterministic tests).
 */
export class StdinSanitizer {
  private held: string | null = null
  private partial = ""
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private partialTimer: ReturnType<typeof setTimeout> | null = null
  private readonly holdMs: number
  private readonly partialMs: number
  private readonly onFlush: ((bytes: string) => void) | undefined

  constructor(options: StdinSanitizerOptions = {}) {
    this.holdMs = options.holdMs ?? HOLD_MS
    this.partialMs = options.partialMs ?? PARTIAL_MS
    this.onFlush = options.onFlush
  }

  /** True while a paste body is held waiting for its end marker. */
  get holding(): boolean {
    return this.held !== null
  }

  /** True while a trailing marker fragment awaits the next chunk. */
  get pendingPartial(): boolean {
    return this.partial.length > 0
  }

  push(chunk: string): string {
    if (chunk.length === 0) return ""
    let out = ""
    let rest = chunk
    if (this.held === null && this.partial.length > 0) {
      rest = this.partial + rest
      this.partial = ""
      this.clearTimer(this.partialTimer)
      this.partialTimer = null
    }
    rest = this.extractMouse(rest)
    for (;;) {
      if (this.held !== null) {
        // Check the paste-end across the chunk boundary too (a marker may
        // straddle held + incoming), never only within `rest`.
        const combined = this.held + rest
        const end = combined.indexOf(PASTE_END)
        if (end === -1) {
          this.held = combined
          this.armHold()
          return rewriteEnters(out)
        }
        out += PASTE_START + combined.slice(0, end) + PASTE_END
        this.held = null
        this.clearTimer(this.holdTimer)
        this.holdTimer = null
        rest = combined.slice(end + PASTE_END.length)
        continue
      }
      const start = rest.indexOf(PASTE_START)
      if (start === -1) {
        // No body in flight: strip lone end markers (Ink would type them),
        // then hold a trailing marker fragment for the next chunk.
        const plain = stripPasteMarkers(rest)
        const tail = trailingMarkerPrefix(plain)
        out += plain.slice(0, plain.length - tail.length)
        if (tail.length > 0) {
          this.partial = tail
          this.armPartial()
        }
        return rewriteEnters(out)
      }
      // Marker(s) before the start: lone ends stripped, text forwarded.
      out += stripPasteMarkers(rest.slice(0, start))
      const after = rest.slice(start + PASTE_START.length)
      const end = after.indexOf(PASTE_END)
      if (end === -1) {
        this.held = after
        this.armHold()
        return rewriteEnters(out)
      }
      out += PASTE_START + after.slice(0, end) + PASTE_END
      rest = after.slice(end + PASTE_END.length)
      continue
    }
  }

  /** Release a stray paste body as plain input (hold timer / tests). */
  flushHeld(): string {
    this.clearTimer(this.holdTimer)
    this.holdTimer = null
    const body = this.held
    this.held = null
    if (body === null || body.length === 0) return ""
    return rewriteEnters(stripPasteMarkers(body))
  }

  /** Resolve a trailing marker fragment (partial timer / tests). */
  flushPartial(): string {
    this.clearTimer(this.partialTimer)
    this.partialTimer = null
    const tail = this.partial
    this.partial = ""
    if (tail.length === 0) return ""
    // A truncated start/end stanza is terminal garbage, not a keystroke —
    // dropping is the only release Ink can never turn into a hostage or
    // into typed litter. Anything else (lone ESC, split CSI…) ships as-is.
    if (tail === PASTE_START.slice(0, -1) || tail === PASTE_END.slice(0, -1)) {
      return ""
    }
    // A parked (never-completed) mouse report fragment: same reasoning —
    // releasing half a CSI sequence would let Ink parse garbage.
    if (tail.startsWith("\x1b[<")) {
      return ""
    }
    return rewriteEnters(tail)
  }

  /** Pull complete mouse reports out of `s`, emitting wheel scrolls and
   *  swallowing everything else (with 1000+1006 enabled a plain click
   *  would otherwise be "typed" by Ink into the composer). An incomplete
   *  trailing report (`\x1b[<64;1`) is parked for the next chunk — the
   *  prepend at the top of push() reassembles it — and flushPartial drops
   *  it if the terminal never completes it. */
  private extractMouse(s: string): string {
    if (!s.includes("\x1b[<") && !s.includes("\x1b[M")) return s
    let out = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, btn: string) => {
      const b = Number(btn)
      if (b === 64) emitMouseScroll("up")
      else if (b === 65) emitMouseScroll("down")
      return ""
    })
    out = out.replace(/\x1b\[M[\s\S]{3}/g, (m) => {
      const b = m.charCodeAt(3) // X10: ESC [ M <button> <col> <row>
      if ((b & 64) !== 0) emitMouseScroll((b & 1) !== 0 ? "down" : "up")
      return ""
    })
    const tail = out.match(/\x1b\[<\d*(?:;\d*){0,2}$/)
    if (tail) {
      out = out.slice(0, out.length - tail[0].length)
      if (this.partial.length === 0 && this.held === null) {
        this.partial = tail[0]
        this.armPartial()
      }
    }
    return out
  }

  dispose(): void {
    this.clearTimer(this.holdTimer)
    this.holdTimer = null
    this.clearTimer(this.partialTimer)
    this.partialTimer = null
    this.held = null
    this.partial = ""
  }

  private armHold(): void {
    this.clearTimer(this.holdTimer)
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      const bytes = this.flushHeld()
      if (bytes.length > 0) this.onFlush?.(bytes)
    }, this.holdMs)
  }

  private armPartial(): void {
    this.clearTimer(this.partialTimer)
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null
      const bytes = this.flushPartial()
      if (bytes.length > 0) this.onFlush?.(bytes)
    }, this.partialMs)
  }

  private clearTimer(id: ReturnType<typeof setTimeout> | null): void {
    if (id !== null) clearTimeout(id)
  }
}

/**
 * Wrap a TTY stream so Ink reads sanitised bytes. The wrapper proxies the
 * TTY surface Ink touches (isTTY/isRaw/isRawModeSupported/setRawMode/ref/
 * unref) to the underlying stream; everything else is a normal PassThrough.
 */
export const createSanitizedStdin = (
  real: NodeJS.ReadStream,
  options: StdinSanitizerOptions = {},
): NodeJS.ReadStream => {
  const out = new PassThrough()
  const sanitizer = new StdinSanitizer({
    ...options,
    onFlush: (bytes: string) => {
      out.write(bytes)
      options.onFlush?.(bytes)
    },
  })

  const onData = (chunk: Buffer | string): void => {
    const bytes = sanitizer.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
    if (bytes.length > 0) out.write(bytes)
  }
  real.on("data", onData)
  real.on("close", () => sanitizer.dispose())

  const typedReal = real as NodeJS.ReadStream & {
    isRaw?: boolean
    setRawMode?: (mode: boolean) => void
    ref?: () => void
    unref?: () => void
  }

  Object.defineProperty(out, "isTTY", {
    get: () => typedReal.isTTY === true,
    configurable: true,
  })
  Object.defineProperty(out, "isRaw", {
    get: () => typedReal.isRaw === true,
    configurable: true,
  })

  const flagged = out as unknown as {
    isRawModeSupported: boolean
    setRawMode: (mode: boolean) => boolean
    ref: () => unknown
    unref: () => unknown
  }
  flagged.isRawModeSupported = typedReal.isTTY === true && typeof typedReal.setRawMode === "function"
  flagged.setRawMode = (mode: boolean) => {
    typedReal.setRawMode?.(mode)
    return mode
  }
  flagged.ref = () => typedReal.ref?.()
  flagged.unref = () => typedReal.unref?.()

  return out as unknown as NodeJS.ReadStream
}

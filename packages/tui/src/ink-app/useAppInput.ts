/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * useInput wrapper that survives coalesced stdin reads. Ink parses each
 * 'data' chunk with parseKeypress, which only recognizes escape sequences —
 * a chunk like "i\r" (last key + Enter drained in one read; common on
 * Windows consoles while a render is in flight) parses as ONE nameless
 * keypress: key.return stays false and the Enter is silently lost, so
 * submits/picks/expands go dead while single-char typing still works
 * (observed live: in="i\r" return=false, never submitted).
 *
 * Replay multi-code-point chunks one char at a time and re-derive Enter from
 * CR code points. Keyboard Enter is '\r' in raw mode on every OS; a '\n'
 * *inside a multi-char* chunk is text content (paste/newline) and is passed
 * through untouched — a lone '\n' arrives as a length-1 chunk and is handled
 * by isEnter() in keys.ts. CRLF collapses to a single Enter.
 */

import { useInput, type Key } from "ink"

export type AppInputHandler = (input: string, key: Key) => void

export interface AppInputOptions {
  isActive?: boolean
}

/** Pure core (unit-tested): fan a raw chunk out to the handler. */
export const replayInputChunk = (raw: string, key: Key, emit: AppInputHandler): void => {
  // Ctrl/meta chords and single chars: Ink's parse is already correct.
  if (key.ctrl || key.meta || raw.length <= 1) {
    emit(raw, key)
    return
  }
  // Shift-Tab arrives as the 3-char escape "\x1b[Z": it is ONE atomic
  // keypress and must emit once. Splitting it below would fire tab/shift
  // handlers three times per press (plan mode would toggle thrice and land
  // back where it started). Other escapes (arrows, F-keys) keep the legacy
  // per-char replay — changing that would alter long-settled navigation.
  if (raw === "[Z") {
    emit(raw, key)
    return
  }
  const chars = [...raw]
  // A multi-char chunk carrying LF plus real text is a PASTE, not keypresses:
  // its line breaks are content (collapse to space, like bracketed-paste
  // handling) and must NEVER submit. Pure break sequences ("\r\n") or CR
  // without LF ("i\r", "a\rb") keep the old Enter derivation — keyboard
  // Enter and coalesced typing+Enter must keep working.
  const isPaste = chars.length > 1 && chars.includes("\n") && chars.some((c) => c !== "\n" && c !== "\r")
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === "\n") {
      if (isPaste) {
        emit(" ", key)
        continue
      }
      emit(ch, key)
      continue
    }
    if (ch === "\r") {
      if (isPaste) {
        if (chars[i + 1] === "\n") continue // CRLF: the LF becomes the space
        emit(" ", key) // lone-CR line break → space
        continue
      }
      emit("\r", { ...key, return: true })
      if (chars[i + 1] === "\n") i += 1 // CRLF = one Enter
      continue
    }
    emit(ch, key)
  }
}

export const useAppInput = (handler: AppInputHandler, options?: AppInputOptions): void => {
  useInput((raw, key) => replayInputChunk(raw, key, handler), options)
}

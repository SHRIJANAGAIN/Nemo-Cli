/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** Types for the vendored `@claude-code/repl` stand-in (see Cursor.js). */

export type FindType = "f" | "F" | "t" | "T"
export type KillPosition = "prepend" | "append"

export type KilledCursor = Cursor & {
  readonly cursor: Cursor
  readonly killed: string
}

export class Cursor {
  constructor(text: string, offset?: number)
  static fromText(text: string, columns: number, offset?: number): Cursor
  readonly text: string
  readonly offset: number
  readonly measuredText: string
  equals(other: unknown): boolean
  isAtEnd(): boolean
  left(): Cursor
  right(): Cursor
  upLogicalLine(): Cursor
  downLogicalLine(): Cursor
  up(): Cursor
  down(): Cursor
  startOfLogicalLine(): Cursor
  endOfLogicalLine(): Cursor
  firstNonBlankInLogicalLine(): Cursor
  startOfFirstLine(): Cursor
  startOfLastLine(): Cursor
  goToLine(count: number): Cursor
  nextVimWord(): Cursor
  prevVimWord(): Cursor
  endOfVimWord(): Cursor
  nextWORD(): Cursor
  prevWORD(): Cursor
  endOfWORD(): Cursor
  nextWord(): Cursor
  prevWord(): Cursor
  findCharacter(ch: string, type: FindType, count?: number): number
  insert(str: string): Cursor
  backspace(): Cursor
  del(): Cursor
  deleteToLineStart(): KilledCursor
  deleteToLineEnd(): KilledCursor
  deleteWordBefore(): KilledCursor
  deleteWordAfter(): KilledCursor
}

export function isVimWordChar(ch: string): boolean
export function isVimWhitespace(ch: string): boolean
export function isVimPunctuation(ch: string): boolean

export function pushToKillRing(text: string, position?: KillPosition): void
export function getLastKill(): string
export function resetKillAccumulation(): void
export function recordYank(start: number, length: number): void
export function updateYankLength(length: number): void
export function yankPop(): { text: string; start: number; length: number } | null
export function resetYankState(): void

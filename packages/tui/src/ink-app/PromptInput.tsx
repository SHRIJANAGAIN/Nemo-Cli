/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode, useState, useEffect, useRef } from "react"
import { Box, Text, usePaste, useStdin, useStdout, type Key } from "ink"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useThemeColors, rgbToHex } from "./themeColors.js"
import { g } from "./glyphs.js"
import { getTheme, selectedForeground } from "../ui/theme.js"
import { stringWidth } from "./utils/stringWidth.js"
import { SLASH_COMMANDS } from "./types.js"
import { isEnter } from "./keys.js"
import { getKeymap } from "../keymap.js"
import { fuzzyMatch, fuzzyMatchScore } from "./fuzzy.js"
import { useAppInput } from "./useAppInput.js"
import type { SlashCommand, ChooserOption, QuestionRequest } from "./types.js"
import { Spinner } from "./Spinner.js"
import {
  deriveMentionState,
  ensureMentionFiles,
  filterMentions,
  insertMention,
  listMentionFiles,
  subscribeMentionFiles,
} from "./file-mention.js"

const MAX_VISIBLE = 10

/** Env-gated dispatch tracer (TRAYAMBAK_DEBUG_INPUT=1): "PI"-prefixed lines
 *  land in the same trayambak-input.log as App's "in="/"SUBMIT" lines, so
 *  cross-handler questions ("which listener saw this keystroke, and when")
 *  are answerable from one file instead of by reasoning about emit order. */
const piLog = (line: string): void => {
  if (process.env.TRAYAMBAK_DEBUG_INPUT !== "1") return
  try {
    appendFileSync(join(tmpdir(), "trayambak-input.log"), `${new Date().toISOString()} PI ${line}\n`)
  } catch {
    /* debug only */
  }
}

export interface CommandDef {
  name: string
  description: string
  category: string
  aliases?: string[]
  argsHint?: string
}

export interface PromptInputProps {
  onSubmit: (input: string, display?: string) => void
  onSlashCommand?: (command: string, args: string) => void
  onChoose?: (command: string, value: string) => void
  /** Ctrl+E / /enhance rewrite callback — returns a result, never throws. */
  onEnhance?: (draft: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** PageUp/PageDown page the conversation transcript. App owns the offset
   *  (shared with the wheel); absent, the keys are inert. */
  onHistoryScroll?: (dir: "up" | "down") => void
  placeholder?: string
  isLoading?: boolean
  disabled?: boolean
  questionHint?: QuestionRequest | null
  askMode?: boolean
  waitingCustom?: boolean
  commandList?: CommandDef[]
  /** Workspace root for the `@` file menu (mention menu off when absent). */
  cwd?: string
  /** Ctrl+R edit-last-prompt: nonce-tagged draft App wants loaded into the buffer. */
  draftRequest?: { text: string; nonce: number } | null
  /** Ctrl+R hook — App answers by pushing a draftRequest. */
  onRetryEdit?: () => void
  /** Ctrl+S inject: App parks the draft at the FRONT of the prompt queue
   *  (priority over Enter-queued prompts). Skipped while answering a
   *  question or custom input — answers must not become queued prompts. */
  onInject?: (draft: string) => void
  /** Ctrl-C on an empty composer: App decides (deny dialog / abort turn /
   *  arm-exit double press). Single Ctrl-C never exits from here. */
  onCtrlCEmpty?: () => void
  /** True while a permission request awaits a decision: with an EMPTY
   *  buffer the decision keys (y/n/a/s/x, Enter, Esc, ↑/↓) belong to the
   *  PermissionOverlay (Ink broadcasts every keypress to all useInput
   *  handlers — both must not act on the same key). With text in the
   *  buffer the composer types normally. */
  permissionPending?: boolean
  /** Reports "draft has text" changes up to App (overlay keys stand down
   *  while the user is typing a message during a permission prompt). */
  onComposerHasTextChange?: (hasText: boolean) => void
}

interface ScoredItem {
  item: SlashCommand | ChooserOption | CommandDef
  score: number
}

const EMPTY_OPTIONS: ScoredItem[] = []
const EMPTY_KNOWN: string[] = []

/** Mention menu rows as ChooserOptions so the shared menu renderer can show
 *  them (value = path, description = file/folder). */
function scoreMentionOptions(query: string, cwd: string | undefined): ScoredItem[] {
  if (!cwd) return EMPTY_OPTIONS
  return filterMentions(query, listMentionFiles(cwd)).map((c): ScoredItem => ({
    item: { value: c.value, description: c.kind === "folder" ? "folder" : "file" },
    score: 1,
  }))
}

// fuzzyMatch / fuzzyMatchScore moved to ./fuzzy.js (shared with the palette).

function filterSlashCommands(query: string, commands: SlashCommand[], commandList: CommandDef[]): ScoredItem[] {
  if (!query.startsWith("/")) return []
  const rest = query.slice(1)

  const commandListByName = new Map<string, CommandDef>()
  for (const cmd of commandList) {
    if (!commandListByName.has(cmd.name)) {
      commandListByName.set(cmd.name, cmd)
    }
  }

  const allCommands: ScoredItem[] = [
    ...commands
      .filter((cmd) => !commandListByName.has(cmd.name))
      .map((cmd) => ({
        item: cmd,
        score:
          fuzzyMatchScore(cmd.name, rest) * (cmd.name.startsWith(rest) ? 2 : 1) +
          fuzzyMatchScore(cmd.description, rest),
      })),
    ...commandList.map((cmd) => ({
      item: cmd,
      score:
        fuzzyMatchScore(cmd.name, rest) * (cmd.name.startsWith(rest) ? 2 : 1) + fuzzyMatchScore(cmd.description, rest),
    })),
  ]

  const seen = new Set<string>()
  return allCommands
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((entry) => {
      const name = "name" in entry.item ? entry.item.name : entry.item.value
      if (seen.has(name)) return false
      seen.add(name)
      return true
    })
}

function filterChooserOptions(options: ChooserOption[], query: string): ChooserOption[] {
  if (!query) return options
  return options.filter(
    (opt) => fuzzyMatch(opt.value, query) || (opt.description ? fuzzyMatch(opt.description, query) : false),
  )
}

function padDisplay(items: ScoredItem[]): ScoredItem[] {
  return items.map((entry) => ({
    item: entry.item,
    score: entry.score,
  }))
}

/** Pastes at/over this many chars collapse to a placeholder (Codex parity:
 *  their tests pin a 1001-char paste collapsing). Count is unicode scalars,
 *  like their `chars().count()` — not UTF-16 units, not bytes. */
export const PASTE_COLLAPSE_CHARS = 1000

/** Placeholder for a collapsed paste: `[Pasted Content N chars]`. */
export function pastePlaceholder(text: string): string {
  return `[Pasted Content ${Array.from(text).length} chars]`
}

/** Unique placeholder for this paste — a second DIFFERENT paste with the
 *  same char count earns a Codex-style ` #2` suffix so the two payloads
 *  never alias. Same text reuses its placeholder (both expand alike). */
export function uniquePastePlaceholder(text: string, pastes: ReadonlyMap<string, string>): string {
  const base = pastePlaceholder(text)
  if (!pastes.has(base) || pastes.get(base) === text) return base
  let n = 2
  while (pastes.has(`${base} #${n}`)) n++
  return `${base} #${n}`
}

/** Expand every known placeholder back to its full text for submit. Unknown
 *  (user-typed or half-deleted) placeholders pass through untouched — only
 *  exact map keys expand, so prose can never detonate into a paste. */
export function expandPastes(draft: string, pastes: ReadonlyMap<string, string>): string {
  let out = draft
  for (const [placeholder, text] of pastes) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(text)
  }
  return out
}

function getDisplayText(item: SlashCommand | ChooserOption | CommandDef): string {
  if ("value" in item) return item.value
  const name = item.name
  if ("category" in item && item.category === "skill") return `/${name}:skill`
  if ("category" in item && item.category === "mcp") return `/${name}:mcp`
  return `/${name}`
}

function getDescription(item: SlashCommand | ChooserOption | CommandDef): string | undefined {
  return item.description
}

/** Pure derivation of slash-menu state from a buffer string. Module-level (not
 *  inline render code) so the Enter handler can re-derive from the ref-fresh
 *  buffer when a coalesced stdin chunk appended chars in the same tick Enter
 *  arrived — render-time values still reflect the previous buffer. */
function deriveSlashState(bufferText: string, commandList: CommandDef[]) {
  const typedCommandName = bufferText.startsWith("/") && bufferText.length > 1 ? bufferText.slice(1).split(" ")[0] : ""
  const isChooserMode =
    typedCommandName.length > 0 &&
    bufferText.includes(" ") &&
    filterSlashCommands("/" + typedCommandName, SLASH_COMMANDS, []).some((entry) => {
      const cmd = entry.item as SlashCommand
      return cmd.chooser !== undefined
    })
  const activeCommand = isChooserMode ? (SLASH_COMMANDS.find((c) => c.name === typedCommandName) ?? null) : null
  const hasChooser = !!activeCommand?.chooser
  const chooserOptions =
    hasChooser && activeCommand?.chooser
      ? filterChooserOptions(activeCommand.chooser, isChooserMode ? bufferText.slice(bufferText.indexOf(" ") + 1) : "")
      : []
  const scoredResults = isChooserMode
    ? chooserOptions.map((opt) => ({ item: opt as SlashCommand | ChooserOption, score: 1 }))
    : filterSlashCommands(bufferText, SLASH_COMMANDS, commandList)
  const visibleOptions = padDisplay(scoredResults)
  return { typedCommandName, isChooserMode, activeCommand, hasChooser, chooserOptions, visibleOptions }
}

export const PromptInput = ({
  onSubmit,
  onSlashCommand,
  onChoose,
  onEnhance,
  onHistoryScroll,
  placeholder = "Ask Trayambak to do anything...",
  isLoading = false,
  disabled = false,
  questionHint = null,
  askMode = false,
  waitingCustom = false,
  commandList = [],
  cwd,
  draftRequest = null,
  onRetryEdit,
  onInject,
  onCtrlCEmpty,
  permissionPending = false,
  onComposerHasTextChange,
}: PromptInputProps): ReactNode => {
  const theme = useThemeColors()
  const { stdout } = useStdout()
  /** Full-width menu lines: Ink's incremental frame write can leave the tail
   *  of a longer previous row visible under a shorter new one ("/diff … for
   *  a file" + stale "themed bubble"). Every row/header/counter is padded to
   *  its exact line width so a rewrite always covers the whole line. */
  const menuInner = Math.max(24, (stdout?.columns ?? 80) - 4) // parent border (2) + menu border (2)
  const rowWidth = Math.max(16, menuInner - 4) // row padding 2 + 2
  // Width-aware pads: `.length` counts UTF-16 units, so any non-ASCII option
  // (Hindi labels) shifted the menu column left of its neighbours.
  const fitRow = (text: string): string =>
    stringWidth(text) >= rowWidth ? text : text + " ".repeat(rowWidth - stringWidth(text))
  const fitLine = (text: string): string =>
    stringWidth(text) >= menuInner ? text : text + " ".repeat(menuInner - stringWidth(text))
  const stdin = useStdin()
  const [buffer, setBuffer] = useState("")
  /** Ctrl+E / /enhance status: in-flight indicator or inline error. Stays in
   *  the composer — a failed enhance must never touch the transcript or the
   *  user's draft. */
  const [enhanceStatus, setEnhanceStatus] = useState<{ phase: "working" } | { phase: "error"; message: string } | null>(
    null,
  )
  const enhanceBusyRef = useRef(/*initialValue*/ false)
  const [showMenu, setShowMenu] = useState(/*initial*/ false)
  // Mirror "draft has text" up to App (PermissionOverlay stands down on its
  // decision keys while the user types). Ref-held callback + flip gate: the
  // effect runs on every keystroke but only reports CHANGES, so App's
  // render isn't churned; the unmount cleanup emits `false` or a stale
  // `true` would dead-lock the overlay's keys once the composer is gone.
  const composerNotifyRef = useRef(onComposerHasTextChange)
  composerNotifyRef.current = onComposerHasTextChange
  const composerHadTextRef = useRef(/*initialValue*/ false)
  useEffect(() => {
    const hasText = buffer.length > 0
    if (composerHadTextRef.current !== hasText) {
      composerHadTextRef.current = hasText
      composerNotifyRef.current?.(hasText)
    }
  }, [buffer])
  useEffect(() => () => composerNotifyRef.current?.(/*hasText*/ false), [])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [mouseHoverIndex, setMouseHoverIndex] = useState<number | null>(null)
  /** Bumped when the async `@` workspace file walk lands (see file-mention). */
  const [mentionRev, setMentionRev] = useState(0)
  /** Last draft handed in via draftRequest — only a NEW nonce rewrites. */
  const lastDraftNonceRef = useRef(0)
  /** Ref-backed composer text. setBuffer is async React state; an Enter
   *  coalesced with freshly-typed chars in the same stdin chunk would read the
   *  buffer before re-render (stale, often "") and silently drop the submit.
   *  The ref makes writes/reads synchronous so submit always sees what the
   *  user actually typed; state mirrors it for rendering. */
  const bufferRef = useRef("")
  /** Large-paste payloads by placeholder: the composer shows
   *  `[Pasted Content N chars]` (Codex parity) while the full text rides
   *  here and expands back on submit. Pruned whenever the buffer empties
   *  (see writeBuffer) so a long session can't hoard pastes. */
  const pastesRef = useRef(new Map<string, string>())
  /** Last `@path` inserted this session — lets deriveMentionState detect
   *  "mention committed, now prose" (SKT AI LABS's sticky mention token). Cleared
   *  whenever the buffer is emptied. */
  const insertedRef = useRef<{ atIndex: number; token: string } | null>(null)
  /** Esc draft protection: a first Esc only ARMS the clear (hint shown), a
   *  second Esc — before any further typing — actually wipes the draft. */
  const [escArmed, setEscArmed] = useState(/*initial*/ false)
  const writeBuffer = (next: string): void => {
    if (!next) insertedRef.current = null
    // Placeholders live and die with the draft text: drop payloads whose
    // placeholder no longer appears, so stale pastes can neither expand
    // later nor pile up over a long session.
    for (const key of [...pastesRef.current.keys()]) {
      if (!next.includes(key)) pastesRef.current.delete(key)
    }
    bufferRef.current = next
    setBuffer(next)
    // Any text change also retires a pending Esc-arm: the next Esc must not
    // wipe a draft the user kept editing after seeing the hint.
    setEscArmed(/*escArmed*/ false)
    // Fresh text retires a stale enhance error; the in-flight indicator is
    // only cleared when the request settles (see runEnhance).
    setEnhanceStatus((prev) => (prev?.phase === "working" ? prev : null))
  }

  /** SKT AI LABS's sparkle port: rewrite the draft in place. Failures stay inline so
   *  the buffer keeps whatever the user typed — nothing can be lost. */
  const runEnhance = async (draft: string): Promise<void> => {
    if (!onEnhance || enhanceBusyRef.current) return
    enhanceBusyRef.current = true
    try {
      const trimmed = draft.trim()
      if (!trimmed) {
        setEnhanceStatus({
          phase: "error",
          message: "Nothing to enhance — type a draft first (Ctrl+E), or /enhance <draft>.",
        })
        return
      }
      setEnhanceStatus({ phase: "working" })
      const result = await onEnhance(trimmed)
      if (result.ok) {
        writeBuffer(result.text)
        setEnhanceStatus(null)
      } else {
        setEnhanceStatus({ phase: "error", message: result.error })
      }
    } catch (error) {
      setEnhanceStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) })
    } finally {
      enhanceBusyRef.current = false
    }
  }

  const slashState = deriveSlashState(buffer, commandList)
  const { isChooserMode, activeCommand, hasChooser, chooserOptions } = slashState
  /** `@` file menu (SKT AI LABS mention port): an in-progress `@query` at the
   *  (append-only) cursor opens the file list; a buffer starting with "/"
   *  keeps the slash menu instead. Mention state re-derives inside the Enter
   *  handler from the ref-fresh buffer, exactly like the slash state. */
  const mentionKnown = cwd ? listMentionFiles(cwd).map((c) => c.value) : EMPTY_KNOWN
  // A buffer starting with "/" is always the slash menu — mentions only open
  // while the composer isn't mid-command.
  const mentionState = buffer.startsWith("/")
    ? null
    : deriveMentionState(buffer, mentionKnown, insertedRef.current ?? undefined)
  const menuMode: "slash" | "mention" | null = askMode
    ? null
    : mentionState
      ? "mention"
      : buffer.startsWith("/")
        ? "slash"
        : null
  const visibleOptions =
    menuMode === "mention" ? scoreMentionOptions(mentionState?.query ?? "", cwd) : slashState.visibleOptions
  const visibleSlice = visibleOptions.slice(scrollTop, Math.min(scrollTop + MAX_VISIBLE, visibleOptions.length))

  const syncScroll = (idx: number) => {
    if (idx < scrollTop) {
      setScrollTop(idx)
    } else if (idx >= scrollTop + MAX_VISIBLE) {
      setScrollTop(idx - MAX_VISIBLE + 1)
    }
  }

  const effectiveSelectedIndex = mouseHoverIndex !== null ? mouseHoverIndex : selectedIndex

  useEffect(() => {
    if (askMode) {
      // Answer mode: never open the slash menu — it would hijack "/..." text
      // answers (e.g. file paths) and the Enter key that must submit them.
      setShowMenu(/*showMenu*/ false)
      return
    }
    if (menuMode !== null) {
      setShowMenu(/*showMenu*/ true)
      const clampedIdx = Math.min(effectiveSelectedIndex, Math.max(0, visibleOptions.length - 1))
      if (clampedIdx !== effectiveSelectedIndex) {
        setSelectedIndex(clampedIdx)
        syncScroll(clampedIdx)
      }
    } else {
      setShowMenu(/*showMenu*/ false)
    }
  }, [buffer, visibleOptions.length, askMode, menuMode])

  // Mention file cache: re-render when the async workspace walk lands, and
  // kick the walk off the moment the @ menu opens (TTL-gated inside).
  useEffect(() => subscribeMentionFiles(() => setMentionRev((v) => v + 1)), [])
  useEffect(() => {
    if (menuMode === "mention" && cwd) ensureMentionFiles(cwd)
  }, [menuMode, cwd, mentionRev])

  // Ctrl+R edit-last-prompt: App hands the draft over with a nonce; only a
  // NEW nonce rewrites the buffer (so asking twice for identical text works).
  useEffect(() => {
    if (!draftRequest || draftRequest.nonce === lastDraftNonceRef.current) return
    lastDraftNonceRef.current = draftRequest.nonce
    writeBuffer(draftRequest.text)
    setSelectedIndex(0)
    setScrollTop(0)
    setShowMenu(/*showMenu*/ false)
  }, [draftRequest])

  useEffect(() => {
    setMouseHoverIndex(null)
  }, [buffer])

  const inputActive = !disabled || askMode

  // Static block caret + mid-turn-only pulse. The old blinky caret swapped
  // solid/blank ~2×/s at IDLE too — every blink repainted the frame and
  // yanked a native-scrolled viewport back to the cursor, so the Windows
  // scrollbar and native drag could never hold still ("windows inbuilt
  // scrollbar se scroll nahi hota"). Now: idle writes ZERO (caret static,
  // no timer), so at rest the terminal owns the viewport natively —
  // wheel (in-app window), drag and the Windows bar all hold position.
  // Mid-turn the busy `●` still pulses (repaints already flow then, and
  // the parked window — not the viewport — owns reading).
  const [caretOn, setCaretOn] = useState(/*initial*/ true)
  useEffect(() => {
    if (!isLoading) return
    const timer = setInterval(() => setCaretOn((v) => !v), 530)
    return () => clearInterval(timer)
  }, [isLoading])

  useEffect(() => {
    if (!stdin.isRawModeSupported) return
    try {
      stdin.setRawMode(/*mode*/ true)
    } catch {
      /* raw mode not available */
    }
  }, [stdin.isRawModeSupported])

  usePaste(
    (text: string) => {
      if (!inputActive) return
      const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim()
      if (!normalized) return
      // Large pastes collapse to `[Pasted Content N chars]` (Codex parity):
      // the box stays one readable line while the full text rides the paste
      // map and expands back on submit — byte-identical to pasting raw.
      if (Array.from(normalized).length >= PASTE_COLLAPSE_CHARS) {
        const placeholder = uniquePastePlaceholder(normalized, pastesRef.current)
        pastesRef.current.set(placeholder, normalized)
        writeBuffer(bufferRef.current + placeholder)
        return
      }
      writeBuffer(bufferRef.current + normalized)
    },
    { isActive: inputActive },
  )

  useAppInput(
    (input: string, key: Key) => {
      piLog(`in=${JSON.stringify(input)} return=${String(key.return)} active=${String(inputActive)}`)
      if (!inputActive) return

      if (getKeymap().matchesInput("tui.input.copy", input, key)) {
        // Single Ctrl-C never exits: with a draft it clears the line
        // (terminal standard); on an empty composer App decides — deny an
        // open dialog, abort a live turn, or arm the idle double-press exit.
        if (bufferRef.current.length > 0) {
          writeBuffer("")
          setShowMenu(/*showMenu*/ false)
          return
        }
        onCtrlCEmpty?.()
        return
      }

      if (getKeymap().matchesInput("tui.global.injectDraft", input, key)) {
        // Inject mid-stream: park the draft at the FRONT of the prompt
        // queue (ahead of Enter-queued prompts) without waiting for the
        // live turn. Skipped while answering questions — answers must not
        // become queued prompts. Empty draft: nothing to park.
        if (askMode || waitingCustom) return
        const draft = expandPastes(bufferRef.current, pastesRef.current).trim()
        if (!draft) return
        writeBuffer("")
        setShowMenu(/*showMenu*/ false)
        onInject?.(draft)
        return
      }

      if (getKeymap().matchesInput("tui.input.clear", input, key)) {
        writeBuffer("")
        setShowMenu(/*showMenu*/ false)
        return
      }

      if (getKeymap().matchesInput("tui.input.help", input, key)) {
        onSlashCommand?.("help", "")
        return
      }

      if (getKeymap().matchesInput("tui.global.enhance", input, key)) {
        // SKT AI LABS's sparkle button: enhance the current draft in place, then
        // review/edit and send normally (repeatable for iteration).
        void runEnhance(expandPastes(bufferRef.current, pastesRef.current))
        return
      }

      if (getKeymap().matchesInput("tui.global.editLast", input, key)) {
        // Edit-last-prompt: App reloads the previous prompt into the buffer
        // via a fresh draftRequest nonce (never auto-resends).
        onRetryEdit?.()
        return
      }

      // Permission decision keys (EMPTY draft only): Ink broadcasts every
      // key to EVERY handler, so with both this box and PermissionOverlay
      // active, one keypress would approve AND insert "y". With no draft
      // the overlay owns y/n/a/s/x + Enter/Esc/↑↓ (it stands down once
      // there IS text — onComposerHasTextChange); any real draft types
      // normally. Trade-off: y/n/a/s/x as the FIRST char of an empty
      // buffer answers the dialog instead of being inserted.
      if (
        permissionPending &&
        bufferRef.current.length === 0 &&
        ((input.length === 1 && "yYnNaAsSxX".includes(input)) ||
          isEnter(input, key) ||
          key.escape ||
          key.upArrow ||
          key.downArrow)
      ) {
        return
      }

      if (key.backspace) {
        // Grapheme-safe: slice(0,-1) on UTF-16 leaves a lone surrogate
        // (same fix as CommandPalette/ModelPicker's Array.from).
        const next = Array.from(bufferRef.current).slice(0, -1).join("")
        writeBuffer(next)
        const nextKnown = cwd ? listMentionFiles(cwd).map((c) => c.value) : EMPTY_KNOWN
        const nextMention =
          !askMode &&
          !next.startsWith("/") &&
          deriveMentionState(next, nextKnown, insertedRef.current ?? undefined) !== null
        setShowMenu(!askMode && (next.startsWith("/") || nextMention))
        return
      }

      if (isEnter(input, key)) {
        let keepBuffer = false
        // Ref-fresh text: chars appended by key replay in this same tick have
        // not re-rendered yet, so the `buffer` state can lag Enter by a chunk.
        // `text` is the EXPANDED submit (model + commands + answers always
        // get whole pastes; unknown text never detonates) while `display`
        // keeps the composer as typed — placeholders intact — so the sent
        // transcript row stays a collapsed block. Identical when no pastes.
        const text = expandPastes(bufferRef.current, pastesRef.current)
        const display = bufferRef.current
        piLog(`ENTER text=${JSON.stringify(text)} ask=${String(askMode)}`)
        try {
          if (text.startsWith("/") && !askMode) {
            // Singular alias: users type "/permission …", the registry only
            // knows "/permissions". Normalize up front so menu filtering,
            // chooser mode, and the exact-builtin fast path below all see
            // the canonical name (otherwise fuzzy top-pick gambles).
            const cmdText = text.replace(/^\/permission(?=\s|$)/, "/permissions")
            const slash = deriveSlashState(cmdText, commandList)
            const slashPart = cmdText.slice(1)
            const typedCommand = slashPart.split(" ")[0].toLowerCase()
            const clampedIndex = Math.min(effectiveSelectedIndex, Math.max(0, slash.visibleOptions.length - 1))
            const selectedEntry = slash.visibleOptions[clampedIndex]
            const selectedItem = selectedEntry?.item

            // Exact builtin wins: a typed builtin name must never lose to a
            // fuzzy prompt-file template ("Built-ins win a name collision").
            // Observed live: "/themes" top-picked a session-template that
            // fuzzy-matched, and Enter submitted its whole body as a prompt
            // instead of listing themes. Direct-call when the user typed a
            // value after the name — or when the command has no chooser.
            // A bare "/permissions " (chooser open, arrows moved, nothing
            // typed) must NOT take this path: it would run display/usage
            // instead of the highlighted option ("permission menu se direct
            // choose nahi hota"). That case falls through to onChoose below.
            const exactBuiltin = SLASH_COMMANDS.find((c) => c.name === typedCommand)
            const typedArgs = slashPart.slice(typedCommand.length + 1)
            if (
              exactBuiltin &&
              (typedArgs.trim() || exactBuiltin.chooser === undefined) &&
              typedCommand !== "enhance"
            ) {
              onSlashCommand?.(exactBuiltin.name, typedArgs)
            } else if (typedCommand === "permissions" && !cmdText.includes(" ")) {
              // Bare "/permission" (aliased above) or "/permissions": open
              // the mode chooser directly instead of gambling on the fuzzy
              // top pick. Previously a non-"permissions" top match fell
              // through to branches that rewrote the buffer or submitted
              // prose, so the menu never reliably opened.
              writeBuffer("/permissions ")
              setShowMenu(/*showMenu*/ true)
              setSelectedIndex(0)
              setScrollTop(0)
              keepBuffer = true
            } else if (typedCommand === "enhance" && onEnhance) {
              // Intercepted here instead of onSlashCommand: the composer owns
              // the buffer, so only it can put the rewrite back after the clear
              // below runs synchronously after this handler returns.
              void runEnhance(slashPart.slice(typedCommand.length + 1))
            } else if (slash.isChooserMode && slash.hasChooser && selectedItem) {
              const opt = selectedItem as ChooserOption
              onChoose?.(typedCommand, opt.value)
            } else if (selectedItem && "chooser" in selectedItem && selectedItem.chooser && !cmdText.includes(" ")) {
              const cmd = selectedItem as SlashCommand
              writeBuffer(`/${cmd.name} `)
              setShowMenu(/*showMenu*/ true)
              setSelectedIndex(0)
              setScrollTop(0)
              keepBuffer = true
            } else if (selectedItem && "name" in selectedItem) {
              const cmd = selectedItem as SlashCommand
              onSlashCommand?.(cmd.name, slashPart.slice(typedCommand.length + 1))
            } else if (selectedItem && "value" in selectedItem) {
              const cmd = slash.activeCommand
              if (cmd) {
                onSlashCommand?.(cmd.name, (selectedItem as ChooserOption).value)
              }
            } else {
              // Nothing matched (or the typed args scored the menu to zero):
              // the typed command + typed args still are the user's intent —
              // pass BOTH instead of dropping the args.
              onSlashCommand?.(typedCommand, slashPart.slice(typedCommand.length + 1))
            }
          } else if (!askMode) {
            // `@` mention: pick the highlighted file/folder into the buffer;
            // with no match the text is prose and submits normally.
            const knownNow = cwd ? listMentionFiles(cwd).map((c) => c.value) : EMPTY_KNOWN
            const mentionNow = deriveMentionState(text, knownNow, insertedRef.current ?? undefined)
            const mentionOptsNow = mentionNow ? scoreMentionOptions(mentionNow.query, cwd) : EMPTY_OPTIONS
            if (mentionNow && mentionOptsNow.length > 0) {
              const clamped = Math.min(effectiveSelectedIndex, Math.max(0, mentionOptsNow.length - 1))
              const picked = mentionOptsNow[clamped]?.item as ChooserOption | undefined
              if (picked) {
                writeBuffer(insertMention(text, "", picked.value))
                insertedRef.current = { atIndex: mentionNow.atIndex, token: picked.value }
                keepBuffer = true
                setSelectedIndex(0)
                setScrollTop(0)
              }
            } else {
              onSubmit(text, display)
            }
          } else {
            onSubmit(text, display)
          }
        } catch (error) {
          // This handler runs inside Ink's stdin dispatch: letting a submit-
          // path throw escape could take the whole TUI down, and skipping the
          // clear below would strand the draft with no feedback (the exact
          // "question never sent, buffer stuck" symptom). Keep the draft
          // visible and surface the failure inline instead.
          keepBuffer = true
          setEnhanceStatus({
            phase: "error",
            message: `submit failed: ${error instanceof Error ? error.message : String(error)}`,
          })
        } finally {
          if (!keepBuffer) {
            writeBuffer("")
            setShowMenu(/*showMenu*/ false)
          }
        }
        return
      }

      if (key.upArrow && showMenu && visibleOptions.length > 0) {
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1)
          syncScroll(next)
          return next
        })
        setMouseHoverIndex(null)
        return
      }

      if (key.downArrow && showMenu && visibleOptions.length > 0) {
        setSelectedIndex((prev) => {
          const next = Math.min(visibleOptions.length - 1, prev + 1)
          syncScroll(next)
          return next
        })
        setMouseHoverIndex(null)
        return
      }

      if (key.pageUp && showMenu && visibleOptions.length > 0) {
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - Math.floor(MAX_VISIBLE / 2))
          syncScroll(next)
          return next
        })
        setMouseHoverIndex(null)
        return
      }

      if (key.pageDown && showMenu && visibleOptions.length > 0) {
        setSelectedIndex((prev) => {
          const next = Math.min(visibleOptions.length - 1, prev + Math.floor(MAX_VISIBLE / 2))
          syncScroll(next)
          return next
        })
        setMouseHoverIndex(null)
        return
      }

      // PageUp/PageDown page the TRANSCRIPT when no menu is open. The offset
      // itself lives in App (shared with the mouse wheel, and anchored across
      // growth — see scroll-math.ts), so this only reports the intent; without
      // a listener the keys stay inert, exactly as before.
      if (!showMenu && (key.pageUp || key.pageDown)) {
        onHistoryScroll?.(key.pageUp ? "up" : "down")
        return
      }

      if (key.escape) {
        // Two-step clear: a single stray Esc must never destroy a typed
        // draft ("nothing sends, my text vanished"). First press arms and
        // shows a hint; only a second Esc before any further typing clears.
        if (bufferRef.current && !escArmed) {
          setEscArmed(/*escArmed*/ true)
          return
        }
        setShowMenu(/*showMenu*/ false)
        setSelectedIndex(0)
        setScrollTop(0)
        setMouseHoverIndex(null)
        writeBuffer("")
        return
      }

      // (No "/"-intercept here: cycling the slash menu on "/" meant the
      // character was never inserted, so "/" could not be typed inside
      // slash-command arguments. Arrow keys navigate the menu instead.)

      // Ctrl/Alt chords must never land as text: modified keys arrive as
      // PRINTABLE input (kitty/CSI-u Ctrl+A → input "a", AltGr/Alt chords →
      // the base letter), which used to be appended to the draft. The
      // chord-specific handlers above already returned for the keys we map.
      if (key.ctrl || key.meta) return

      // Accept any printable input — the old ASCII-only gate (">= ' ' &&
      // <= '~'") silently dropped accented letters, emoji, and non-Latin
      // scripts mid-composition. Control bytes are still refused (Enter,
      // Tab, and friends are handled above).
      if (input && !/[\u0000-\u001f\u007f]/.test(input)) {
        writeBuffer(bufferRef.current + input)
      }
    },
    { isActive: inputActive },
  )

  const promptGlyph = g("prompt")

  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {askMode && !waitingCustom && questionHint && questionHint.options.length > 0 && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          <Text color={theme.warning} bold>
            {`${g("picker")} ` + questionHint.question}
          </Text>
          {questionHint.options.map((opt, i) => (
            <Text key={i} color={theme.textMuted}>
              {`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`}
            </Text>
          ))}
          <Text color={theme.textMuted}>{"  other. Type a custom answer"}</Text>
          <Text dimColor>
            {questionHint.multiSelect
              ? "Type numbers separated by spaces (e.g. 1 3), or 'other' for custom text."
              : "Type a number (e.g. 1), or 'other' for custom text."}
          </Text>
        </Box>
      )}
      {waitingCustom && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          <Text color={theme.warning} bold>
            {`${g("prompt")} Custom answer (press Enter to submit)`}
          </Text>
        </Box>
      )}
      {escArmed && <Text color={theme.warning}>{"press Esc again to clear the draft"}</Text>}
      <Box alignItems="flex-end">
        {/* Busy `●` (loading) PULSES primary↔warning on the caret tick —
            color only, the glyph itself never swaps (oracles keep ●). */}
        <Text color={isLoading ? (caretOn ? theme.primary : theme.warning) : theme.primary} bold>
          {promptGlyph}
        </Text>
        <Text> </Text>
        {/* Block caret at the typing position: the hardware caret is hidden
            for the app's lifetime (App effect) because Ink never
            repositions it — it floated wherever the last frame write ended
            ("wo blinker show ho raha"). STATIC (always solid ▌): a blinking
            caret repainted the frame ~2×/s even at idle and yanked a
            native-scrolled viewport on every blink. */}
        {buffer.length === 0 && inputActive && <Text color={theme.primary}>{g("caret")}</Text>}
        {buffer.length > 0 ? (
          <Text color={isLoading ? theme.info : theme.warning}>{buffer}</Text>
        ) : (
          <Text dimColor>
            {askMode ? (waitingCustom ? "Your custom answer..." : "Your answer (number or text)...") : placeholder}
          </Text>
        )}
        {buffer.length > 0 && inputActive && <Text color={isLoading ? theme.info : theme.primary}>{g("caret")}</Text>}
      </Box>

      {enhanceStatus &&
        (enhanceStatus.phase === "working" ? (
          <Spinner color={theme.info}>{g("star")} enhancing prompt...</Spinner>
        ) : (
          <Text color={theme.error}>{`${g("warn")} ${enhanceStatus.message}`}</Text>
        ))}

      {showMenu && (
        <Box
          flexDirection="column"
          marginLeft={0}
          marginTop={1}
          backgroundColor={theme.backgroundMenu}
          borderColor={theme.border}
          borderStyle="round"
          width="100%"
        >
          {menuMode === "mention" && (
            <Text color={theme.textMuted}>
              {fitLine(`  @${mentionState?.query ?? ""} — files (${visibleOptions.length})`)}
            </Text>
          )}
          {isChooserMode && hasChooser && activeCommand && (
            <Text color={theme.textMuted}>
              {fitLine(`  /${activeCommand.name} — choose a value (${chooserOptions.length})`)}
            </Text>
          )}
          {visibleOptions.length > 0 ? (
            visibleSlice.map((entry, idx) => {
              const realIndex = scrollTop + idx
              const isActive = realIndex === effectiveSelectedIndex
              const item = entry.item
              const display = getDisplayText(item)
              const description = getDescription(item)
              const selFg = rgbToHex(selectedForeground(getTheme().primary))
              const itemKey = `${realIndex}-${display}`

              return (
                <Box
                  key={itemKey}
                  flexDirection="row"
                  alignItems="flex-start"
                  backgroundColor={isActive ? theme.primary : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                  width="100%"
                >
                  <Text color={isActive ? selFg : theme.text} wrap="truncate-end">
                    {fitRow(`${display}${description ? `  ${description}` : ""}`)}
                  </Text>
                </Box>
              )
            })
          ) : (
            <Text color={theme.textMuted}>{fitLine("  No matching items")}</Text>
          )}
          {visibleOptions.length > MAX_VISIBLE && (
            <Text dimColor>
              {fitLine(
                `  — ${scrollTop + 1}-${Math.min(scrollTop + MAX_VISIBLE, visibleOptions.length)} / ${visibleOptions.length}`,
              )}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}

export default PromptInput

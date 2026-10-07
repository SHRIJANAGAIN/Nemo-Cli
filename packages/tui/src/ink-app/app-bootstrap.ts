/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// Bootstrap helpers for TrayambakApp: env-gated input tracing, bracketed-paste
// enable/disable, agent-config defaults, transcript -> AgentMessage conversion, and
// the terminal ROWS hook. Split out of App.tsx so they are unit-testable without
// mounting the component (see app-bootstrap.test.ts).
import { useEffect, useRef, useState } from "react"
import { useStdout } from "ink"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TrayambakConfig } from "../../../../apps/runtime/src/config.js"
import type { AgentMessage } from "../../../protocol/src/index.js"
import type { PermissionMode, TrayambakMessage } from "./types.js"

/** Env-gated input tracer (TRAYAMBAK_DEBUG_INPUT=1): records exact stdin
 * bytes, key flags, and raw/tty state per keystroke to trayambak-input.log. */
export const debugInputLog = (line: string): void => {
  if (process.env.TRAYAMBAK_DEBUG_INPUT !== "1") return
  try {
    appendFileSync(join(tmpdir(), "trayambak-input.log"), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* debug only */
  }
}

export function enableBracketedPaste(): () => void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h")
    return () => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004l")
      }
    }
  }
  return () => {}
}

export interface TrayambakAppProps {
  config?: Partial<TrayambakConfig>
  modelName?: string
  permissionMode?: PermissionMode
  onExit?: () => void
  initialPrompt?: string
}

export function createAgentConfig(partial: Partial<TrayambakConfig>): TrayambakConfig {
  return {
    baseUrl: partial.baseUrl ?? "http://localhost:8080",
    model: partial.model ?? "trayambak",
    apiKey: partial.apiKey ?? "",
    // Provider must pass through: dropping it silently rebuilds every agent
    // as NVIDIA (Agent defaults provider ?? "nvidia") — observed live as an
    // HF login (router baseUrl + HF key + Llama model) failing with
    // "NVIDIA API returned 401".
    ...(partial.provider ? { provider: partial.provider } : {}),
    ...(partial.reasoningEffort ? { reasoningEffort: partial.reasoningEffort } : {}),
    cwd: partial.cwd ?? process.cwd(),
    temperature: partial.temperature ?? 0.7,
    topP: partial.topP ?? 0.9,
    maxTokens: partial.maxTokens ?? 4096,
    timeoutMs: partial.timeoutMs ?? 600_000,
    shellCommand: partial.shellCommand ?? "bash -c",
    maxOutputLines: partial.maxOutputLines ?? 2000,
    maxOutputBytes: partial.maxOutputBytes ?? 256 * 1024,
    maxTurns: partial.maxTurns ?? 64,
    // Session budget must survive the rebuild: dropping it here deactivated
    // every configured/env budget in TUI sessions — the loop only applies
    // run.config.budget, so a set cap went silently unenforced (#64).
    ...(partial.budget !== undefined ? { budget: partial.budget } : {}),
    maxToolCalls: partial.maxToolCalls ?? 100,
    maxDistinctToolCalls: partial.maxDistinctToolCalls ?? 1000,
    toolCallRate: partial.toolCallRate ?? 2,
    maxRetries: partial.maxRetries ?? 2,
    retryDelayMs: partial.retryDelayMs ?? 750,
    maxParallelToolCalls: partial.maxParallelToolCalls ?? 4,
    nativeTools: partial.nativeTools ?? true,
    toolsets: partial?.toolsets?.defaults?.length
      ? partial.toolsets
      : { defaults: ["core", "agentic", "ops", "tasks", "mcp", "skills"], disabled: [], platform: {} },
    ...(partial.permissions ? { permissions: partial.permissions } : {}),
    // Developer mode must survive the agent-config rebuild: dropping it here
    // rebuilt every fresh session with the engine default (enabled:false), so
    // a saved /devmode ON (and the gate flag) never reached the model after
    // a restart.
    ...(partial.developerMode ? { developerMode: partial.developerMode } : {}),
    // Operator identity must survive the rebuild too: dropping githubLogin
    // here rebuilt every fresh session's agent as logged-out — /github
    // login worked, TUI restarted, and the ## OPERATOR block still read
    // "not logged in", so the agent never knew its principal. License key
    // + server URL ride along for the same reason (operator-block license
    // line). Display values only — secrets never reach the prompt.
    ...(partial.githubLogin ? { githubLogin: partial.githubLogin } : {}),
    ...(partial.licenseKey ? { licenseKey: partial.licenseKey } : {}),
    ...(partial.licenseServerUrl ? { licenseServerUrl: partial.licenseServerUrl } : {}),
    // MCP servers + skills dir must survive the rebuild too: dropping
    // mcpServers rebuilt every agent with zero MCP tools even when servers
    // were configured (observed live: /mcp dead, mcp__* never reached the
    // model). Same drop class as provider/developerMode above.
    ...(partial.mcpServers ? { mcpServers: partial.mcpServers } : {}),
    ...(partial.skillsDir ? { skillsDir: partial.skillsDir } : {}),
  }
}

export function convertToAgentMessages(msgs: TrayambakMessage[]): AgentMessage[] {
  const result: AgentMessage[] = []
  for (const msg of msgs) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content ?? "" })
    } else if (msg.role === "user") {
      result.push({ role: "user", content: msg.content ?? "" })
    } else if (msg.role === "assistant") {
      if (msg.toolCallId && msg.toolName) {
        // UI tool-call row: rebuild the toolCall part + its result so the
        // model keeps tool context across turns. Was: args JSON replayed as
        // fake assistant prose, result dropped entirely — every turn the
        // model lost all tool outputs.
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(msg.content ?? "{}")
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          } else {
            args = { value: parsed }
          }
        } catch {
          args = { value: msg.content ?? "" }
        }
        result.push({
          role: "assistant",
          content: [{ type: "toolCall", id: msg.toolCallId, name: msg.toolName, arguments: args }],
          stopReason: "tool_use",
        })
        if (msg.result !== undefined) {
          result.push({
            role: "tool",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            content: [{ type: "text", text: msg.result }],
            isError: msg.isError ?? false,
          })
        }
      } else {
        // Thinking rides along: dropping it (old code) lost reasoning
        // context on every history rebuild (compact/retry/queue).
        const parts: Array<{ type: "text"; text: string } | { type: "thinking"; text: string }> = []
        if (msg.thinking) parts.push({ type: "thinking", text: msg.thinking })
        parts.push({ type: "text", text: msg.content ?? "" })
        result.push({
          role: "assistant",
          content: parts,
          stopReason: "end_turn",
        })
      }
    } else if (msg.role === "tool") {
      if (msg.toolCallId && msg.toolName) {
        result.push({
          role: "tool",
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          content: [{ type: "text", text: msg.content ?? "" }],
          isError: msg.isError ?? false,
        })
      }
    }
  }
  return result
}

/**
 * Terminal ROWS for the root Box's fixed height (height={rows}) — the fix
 * for "width grows on resize but the frame never grows downward": Ink only
 * setWidth()s the root, so height="100%" resolved against nothing and the
 * frame hugged content instead of reaching the terminal bottom.
 *
 * Deliberately NOT ink's useWindowSize(): that hook also re-sets state on
 * COLUMN changes, re-rendering the whole tree after a width resize — a
 * second full-frame paint right behind resize-guard's blank+repaint and
 * Ink's own resized() write (smoke-resize-guard counts Welcome frames and
 * saw 2 instead of 1). Width re-flow is owned by the guard + Ink; React
 * only has to follow ROWS so the root Box grows/shrinks downward.
 */
export const useTerminalRows = (): number => {
  const { stdout } = useStdout()
  const [rows, setRows] = useState<number>(() => stdout?.rows || process.stdout?.rows || 24)
  useEffect(() => {
    if (!stdout) return undefined
    const onResize = (): void => {
      // 0/undefined rows (console reattach) → same fallback as ink's
      // getWindowSize truthy check, never height={0}.
      const next = stdout.rows || process.stdout?.rows || 24
      setRows((prev) => (prev === next ? prev : next))
    }
    stdout.on("resize", onResize)
    return () => {
      stdout.removeListener("resize", onResize)
    }
  }, [stdout])
  return rows
}

/**
 * Below this the window cannot host the TUI at all (minimized-to-taskbar
 * transiently reports 0x0; a sub-letterbox window fits nothing readable).
 * Sizes under the floor are REFUSED so paints keep the last good geometry
 * instead of collapsing: a collapsed paint shrinks every erase count with
 * it, and the restore repaint then erases only those few rows — leaving the
 * rest of the viewport as permanent residue that no later repaint touches
 * (each one erases exactly what it paints). A too-big paint into a hidden
 * window is harmless; a too-small paint poisons every paint after it.
 */
export const MIN_USABLE_COLUMNS = 20
export const MIN_USABLE_ROWS = 10

/**
 * Live console size via syscall, bypassing Node's cached columns/rows.
 *
 * Those cached values only refresh when a 'resize' event arrives — and on
 * some consoles no event ever arrives (verified live: a window stretched
 * mid-run never emitted once, columns/rows frozen at launch size). The app
 * then paints a launch-size frame into a smaller window forever, and every
 * repaint scrolls clones into scrollback. getWindowSize() asks the OS
 * directly instead, so it sees the real window with or without events.
 * Null when unavailable (pipes, tests) or when the answer is nonsense.
 */
export interface LiveWindowSize {
  columns: number
  rows: number
}

export function readLiveWindowSize(
  stdout: { getWindowSize?: () => unknown } | undefined | null,
): LiveWindowSize | null {
  try {
    const raw = stdout?.getWindowSize?.()
    if (!Array.isArray(raw)) return null
    const columns = Math.floor(Number(raw[0]))
    const rows = Math.floor(Number(raw[1]))
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return null
    // Zero/negative is dead air, and anything under the usable floor is a
    // transient (minimize reports 0x0; letterbox sizes fit nothing) — refuse
    // both so callers keep last-good geometry instead of collapsing paints.
    if (columns < MIN_USABLE_COLUMNS || rows < MIN_USABLE_ROWS) return null
    return { columns, rows }
  } catch {
    return null
  }
}

/**
 * Overwrite Node's cached columns/rows with syscall truth. Returns true when
 * anything changed. This is what makes Ink's own layout (Yoga widths, wrap,
 * erase math — all read the cache, never the syscall) see the real window on
 * consoles where 'resize' never fires. Emits NO events itself: calling this
 * mid-render and emitting there would nest an Ink render inside React's, so
 * the poll loop owns event emission and render paths only ever assign.
 */
export function syncWindowSizeCache(stdout: {
  columns?: number
  rows?: number
  getWindowSize?: () => unknown
}): boolean {
  const live = readLiveWindowSize(stdout)
  if (!live) return false
  if (stdout.columns === live.columns && stdout.rows === live.rows) return false
  stdout.columns = live.columns
  stdout.rows = live.rows
  return true
}

/**
 * True between a terminal resize and 200ms of quiet after it. While set, the
 * welcome screen paints NARROW chrome (unpadded logo, no fill rows): full-width
 * rows are what a shrink-drag re-flows into scrollback, and fewer of them
 * means proportionally less residue. Borders/footer/composer stay full-width
 * (cheap to keep, small damage), so a drag leaves stray rows, not frames.
 * Restores automatically at settle; the guard's own settle blank then wipes
 * the viewport and the next tick repaints full beauty in place.
 */
export function useResizingFlag(settleMs = 200): boolean {
  const { stdout } = useStdout()
  const [resizing, setResizing] = useState(/*resizing*/ false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!stdout) return undefined
    const onResize = (): void => {
      setResizing(/*resizing*/ true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined
        setResizing(/*resizing*/ false)
      }, settleMs)
    }
    stdout.on("resize", onResize)
    return () => {
      stdout.removeListener("resize", onResize)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [stdout, settleMs])
  return resizing
}

/**
 * Alternate-screen mode (codex-style): run the TUI on the terminal's alternate
 * buffer instead of inline.
 *
 * Why this exists: every resize-clone mechanism in this file fights the same
 * physics — inline rows live in scrollback, so re-flow, over-height paints
 * and stale erases can all strand copies there permanently. The alternate
 * buffer HAS no scrollback, so clones are structurally impossible there:
 * resizes, overflows and stale erases can only ever disturb the live
 * viewport, which the next repaint fixes. That is the entire reason codex
 * never clones.
 *
 * The price is real: with no scrollback the device scrollbar and wheel go
 * dead for the session, and history that scrolls out of the frame cannot be
 * scrolled back to — there is no in-app scroll window either (rollouts stay
 * listable/resumable, but the terminal transcript is not replayed). That
 * trade was accepted deliberately: clone-free rendering beat scroll-back
 * history, so the alternate buffer is the DEFAULT. Inline mode survives as
 * an explicit opt-out (`--no-alt-screen` / TRAYAMBAK_ALT_SCREEN=0) for
 * users who would rather have terminal scrollback than clone-free frames.
 */
export const ALT_SCREEN_ENTER = "[?1049h"
export const ALT_SCREEN_LEAVE = "[?1049l[?25h"

const ALT_TRUTHY = new Set(["1", "true", "yes", "y", "on"])

/**
 * Should this launch use the alternate screen? Explicit CLI flag wins, then
 * the environment, then ON (default-on since the top-clone fix: the alternate
 * buffer is the only surface where reflow cannot strand frames — verified by
 * scripts/diag-boot-clone.mjs --prod --alt --shrink). Pure (unit-tested) —
 * the flag arrives as the strict parser's "true"/"false"/absent strings,
 * never a real boolean.
 */
export function resolveAltScreen(input: {
  flag?: string | boolean | undefined
  env?: Record<string, string | undefined>
}): boolean {
  if (typeof input.flag === "boolean") return input.flag
  if (typeof input.flag === "string") return ALT_TRUTHY.has(input.flag.trim().toLowerCase())
  const raw = input.env?.TRAYAMBAK_ALT_SCREEN
  if (raw === undefined) return true
  return ALT_TRUTHY.has(raw.trim().toLowerCase())
}

/** Write the enter sequence. TTY check lives with the caller (ink-repl.mjs):
 *  emitting 1049h into a pipe would corrupt piped output with an escape the
 *  reader never asked for. */
export function enterAltScreen(write: (chunk: string) => unknown): void {
  write(ALT_SCREEN_ENTER)
}

/**
 * Write the leave sequence. Restores the main buffer AND the caret: the app
 * hides the hardware caret for its lifetime and process.exit skips React's
 * unmount cleanup, so without the ?25h the shell would come back caret-less.
 */
export function leaveAltScreen(write: (chunk: string) => unknown): void {
  write(ALT_SCREEN_LEAVE)
}

/**
 * Live viewport height for frame sizing. Prefer the terminal's CURRENT row
 * count over the React-state one.
 *
 * Why this exists: Ink re-renders on resize from its OWN listener, which runs
 * before this hook's setState lands — so the first post-resize render still
 * sees the OLD height. A root height / fill budget derived from that stale
 * value describes a window that no longer exists: after a shrink the frame is
 * taller than the viewport, every repaint writes past the last row, the
 * console scrolls, and full frames stack up in scrollback (reported live as
 * the same Welcome screen copy-pasted after every resize). Node has already
 * updated stdout.rows by the time any listener runs, so reading it at render
 * time is fresh where state is one render behind. `|| fallback` keeps the
 * 0/undefined reattach behaviour (never height 0).
 */
export function liveViewportRows(stdoutRows: number | undefined, stateRows: number): number {
  return stdoutRows || stateRows
}

/**
 * Rows of ThemeFill below the welcome status block. Calibrated so the whole
 * idle frame EXACTLY fills the viewport: root border 2 + welcome block 13
 * (padding 2 + 8-row lockup + margin 1 + clock 1 + cwd 1) + footer 3 + composer
 * 2 = 20, so fill = viewport - 21 with the root's one row of slack (height =
 * rows - 1) taken by the frame itself. An exact fit never scrolls; anything
 * taller scrolls once per repaint and clones into scrollback.
 */
export function welcomeFillRows(viewportRows: number): number {
  return Math.max(0, Math.min(viewportRows - 21, 30))
}

/**
 * Below this viewport height the full 8-row lockup no longer fits the idle
 * frame (20 fixed rows need 21), so the welcome screen falls back to its
 * one-line compact mark instead of overflowing — an overflowing frame scrolls
 * on every repaint and that scroll IS the clone mechanism. Same trade the
 * theme picker already makes (FULL_LOGO_ROWS vs its 1-row compact logo).
 */
export const WELCOME_COMPACT_BELOW_ROWS = 22

export function welcomeLogoCompact(viewportRows: number): boolean {
  return viewportRows < WELCOME_COMPACT_BELOW_ROWS
}

/**
 * Settle-reprint handler slot (framework-free bridge from the resize guard
 * to App).
 *
 * The guard sees every resize but owns no React state; App owns
 * setStaticEpoch but mounts after Ink's own resize listener. A prop would
 * arrive too late and an event would race, so they meet here: App registers
 * a callback on mount (unregisters on unmount), and the guard invokes it —
 * synchronously inside its settle — when a reprint is due. Same module
 * instance on both sides (both live in ink-app-esm), so there is exactly
 * one slot, never two owners.
 */
let settleReprintHandler: (() => void) | undefined

export function registerSettleReprintHandler(handler: (() => void) | undefined): void {
  settleReprintHandler = handler
}

export function requestSettleReprint(): void {
  settleReprintHandler?.()
}

/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import { CURSOR_HOME, csi, ERASE_SCREEN, ERASE_SCROLLBACK } from "./termio/csi.js"

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, "f")

function isWindowsTerminal(): boolean {
  return process.platform === "win32" && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === "mintty") {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === "win32" && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (process.platform === "win32" && process.env.TERM_PROGRAM === "vscode" && process.env.TERM_PROGRAM_VERSION) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * Screen-only clear. Erases the viewport and homes the cursor, but NEVER
 * touches the scrollback.
 *
 * This is what a REPAINT needs, and the distinction is load-bearing. The chat
 * UI keeps its transcript by printing settled rows to the terminal's native
 * scrollback via Ink's `<Static>` and repainting only the live tail in-frame,
 * which is what makes the device's own scrollbar an accurate view of the
 * conversation. That scrollback is the only copy of the printed history.
 *
 * The renderer's flicker recovery (`log-update.ts` → `fullResetSequence`, on a
 * window resize or any offscreen reflow) used to emit a `clearTerminal` patch,
 * and that patch was rendered with the full sequence below — which includes
 * ED3 on a modern Windows Terminal. Every resize therefore deleted the already
 * printed transcript from the terminal: messages vanished and scrolling back
 * showed nothing. A repaint is not a reset.
 *
 * No capability branch here on purpose. Dropping scrollback is never the right
 * answer for a repaint, on any terminal, so this is one fixed sequence.
 */
export function getClearScreenSequence(): string {
  return ERASE_SCREEN + CURSOR_HOME
}

/**
 * Returns the ANSI escape sequence to clear the terminal INCLUDING scrollback.
 * Automatically detects terminal capabilities.
 *
 * Reserve this for a genuine full reset — one where losing scrollback is the
 * intent. Never use it to recover from a repaint; see `getClearScreenSequence`.
 */
export function getClearTerminalSequence(): string {
  if (process.platform === "win32") {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
    } else {
      // Legacy Windows console - can't clear scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()

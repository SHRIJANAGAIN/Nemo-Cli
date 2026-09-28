/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn } from "node:child_process"
import type { TrayambakMessage } from "./types.js"

/** PowerShell reads the payload over a UTF-8 pipe (the console codepage
 *  would mangle non-ASCII) and hands it to Set-Clipboard. */
const WINDOWS_COPY_COMMAND =
  "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
  "Set-Clipboard -Value ([Console]::In.ReadToEnd())"

/** Pipe `text` into `cmd`'s stdin; resolve on exit 0, reject otherwise. */
const pipeToClipboard = (cmd: string, args: string[], text: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${cmd} timed out`))
    }, 10_000)
    // Don't hold the event loop hostage: after /copy, TUI exit could hang
    // up to the full 10s on this handle alone.
    timer.unref?.()
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      fn()
    }
    // ENOENT = helper not installed (the common Linux case): surface it
    // plainly instead of a bare spawn error.
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      done(() =>
        reject(
          code === "ENOENT"
            ? new Error(`${cmd} not found — install wl-copy, xclip, or xsel for clipboard support`)
            : err,
        ),
      )
    })
    child.on("close", (code) => {
      if (code === 0) {
        done(() => resolve())
      } else {
        done(() => reject(new Error(`${cmd} exited with code ${code ?? "signal"}`)))
      }
    })
    // EPIPE if the tool exits before consuming stdin (failed helper on
    // Linux): the close handler reports the real failure.
    child.stdin?.on("error", () => {})
    child.stdin?.end(text, "utf8")
  })

/** Copy text to the system clipboard — SKT AI LABS's "Copy transcript" parity
 *  without new dependencies: PowerShell Set-Clipboard on Windows, pbcopy
 *  on macOS, wl-copy → xclip → xsel on Linux. NOT OSC 52 (invisible to
 *  the terminal, real system clipboard). Rejects when no helper exists. */
export const copyTextToClipboard = async (text: string): Promise<void> => {
  if (process.platform === "win32") {
    await pipeToClipboard("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COPY_COMMAND], text)
    return
  }
  if (process.platform === "darwin") {
    await pipeToClipboard("pbcopy", [], text)
    return
  }
  const candidates: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ]
  let lastError: unknown
  let missingCount = 0
  for (const [cmd, args] of candidates) {
    try {
      await pipeToClipboard(cmd, args, text)
      return
    } catch (error) {
      lastError = error
      if (error instanceof Error && /not found — install/.test(error.message)) {
        missingCount += 1
      }
    }
  }
  // All helpers missing (common on minimal Linux): one actionable error,
  // not the last candidate's bare spawn failure.
  if (missingCount === candidates.length) {
    throw new Error("no clipboard helper found (install wl-copy, xclip, or xsel)")
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("no clipboard helper found (install wl-copy, xclip, or xsel)")
}

export type TranscriptScope = "all" | "last"

const roleLabel = (m: TrayambakMessage): string => {
  if (m.role === "user") return "You"
  if (m.role === "system") return "System"
  if (m.role === "tool") return `Tool result · ${m.toolName ?? "tool"}`
  if (m.role === "assistant" && m.toolName) return `Tool · ${m.toolName}`
  return "Assistant"
}

const messageBody = (m: TrayambakMessage): string => {
  // Verbatim copy: the display normalizer (stair-indent) must never rewrite
  // clipboard bytes — /copy of a diff/diagram used to lose a column per
  // line (copy ≠ source).
  const content = (m.content ?? "").trim()
  const thinking = (m.thinking ?? "").trim()
  const result = (m.result ?? "").trim()
  if (m.toolName && (m.role === "tool" || m.role === "assistant")) {
    // Assistant tool-call rows carry JSON args in `content`; tool rows
    // carry the raw result there. Print args then result when both exist.
    const parts = content ? [content] : []
    if (result && result !== content) parts.push(result)
    return parts.join("\n")
  }
  return content || thinking
}

/** Plain-text transcript for the clipboard: role-prefixed blocks in
 *  conversation order. "last" returns only the newest assistant reply
 *  (empty string when there is none — the caller reports it). */
export const formatTranscript = (messages: TrayambakMessage[], scope: TranscriptScope = "all"): string => {
  const selected: TrayambakMessage[] = []
  if (scope === "last") {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role === "assistant" && !m.toolName && messageBody(m)) {
        selected.push(m)
        break
      }
    }
  } else {
    selected.push(...messages)
  }
  const blocks: string[] = []
  for (const m of selected) {
    const body = messageBody(m)
    if (!body) continue
    blocks.push(`${roleLabel(m)}:\n${body}`)
  }
  return blocks.join("\n\n")
}

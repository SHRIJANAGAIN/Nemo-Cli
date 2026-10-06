/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { execFile, execFileSync } from "child_process"
import type { AgentEvent } from "../../protocol/src/index.js"
import { writeSync } from "fs"

export interface NotificationConfig {
  enabled: boolean
  onToolError: boolean
  onPermissionRequest: boolean
  onAgentEnd: boolean
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  onToolError: true,
  onPermissionRequest: true,
  onAgentEnd: false,
}

const OSC9_TERMINALS: ReadonlySet<string> = new Set(["ghostty", "iTerm.app", "kitty", "warp", "WezTerm"])

export function terminalSupportsOsc9(): boolean {
  if (!process.stdout.isTTY) return false
  const termProgram = process.env.TERM_PROGRAM
  if (!termProgram) return false
  return OSC9_TERMINALS.has(termProgram)
}

export function isTmux(): boolean {
  return !!process.env.TMUX
}

function escapeTmuxPayload(message: string): string {
  return message.replace(/\x1b/g, "\x1b\x1b")
}

export function osc9Notify(title: string, body: string): boolean {
  if (!process.stdout.isTTY) return false
  try {
    const message = `${title}: ${body}`
    let seq: string
    if (isTmux()) {
      const escaped = escapeTmuxPayload(message)
      seq = `\x1bPtmux;\x1b\x1b]9;${escaped}\x07\x1b\\`
    } else {
      seq = `\x1b]9;${message}\x07`
    }
    writeSync(1, seq)
    return true
  } catch {
    return false
  }
}

export function osNotify(title: string, body: string): void {
  if (terminalSupportsOsc9()) {
    if (osc9Notify(title, body)) return
  }
  try {
    if (process.platform === "win32") {
      const safeTitle = title.replace(/"/g, "'").replace(/\n/g, " ")
      const safeBody = body.replace(/"/g, "'").replace(/\n/g, " ").slice(0, 400)
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("' +
            safeBody +
            '", "' +
            safeTitle +
            '", "OK", "Information")',
        ],
        { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else if (process.platform === "darwin") {
      execFileSync(
        "osascript",
        [
          "-e",
          'display notification "' + body.replace(/"/g, '\\"') + '" with title "' + title.replace(/"/g, '\\"') + '"',
        ],
        { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else {
      execFileSync("notify-send", [title, body], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
    }
  } catch {}
}

export function notifyPermissionRequest(tool: string, body: string): void {
  const title = "TRAYAMBAK – Approval Required"
  if (process.platform === "win32") {
    const safeTitle = title.replace(/'/g, "''")
    const safeBody = `${tool} needs approval: ${body}`.replace(/'/g, "''").replace(/\r?\n/g, " ").slice(0, 400)
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      `$n.BalloonTipTitle = '${safeTitle}';`,
      `$n.BalloonTipText = '${safeBody}';`,
      "$n.Visible = $true;",
      "[System.Media.SystemSounds]::Exclamation.Play();",
      "$n.ShowBalloonTip(2000);",
      "Start-Sleep -Milliseconds 2000;",
      "$n.Dispose();",
    ].join(" ")
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        windowsHide: true,
      },
      () => {},
    )
    child.on("error", () => {})
    return
  }
  osNotify(title, `${tool} needs approval`)
}

/** Throttled per-key bookkeeping for notifyBalloon. */
const lastBalloonAt = new Map<string, number>()

/**
 * Non-blocking OS notification — Windows toast balloon / macOS notification /
 * notify-send. Unlike osNotify's blocking MessageBox this fires and forgets,
 * so it is safe to call inside Ink's event loop. Failures are swallowed, a
 * busy agent can't spam the desktop (minGapMs per key), and
 * TRAYAMBAK_NO_NOTIFY=1 disables it entirely.
 */
export function notifyBalloon(key: string, title: string, body: string, minGapMs = 4000): boolean {
  if (process.env.TRAYAMBAK_NO_NOTIFY === "1") return false
  const now = Date.now()
  if (now - (lastBalloonAt.get(key) ?? 0) < minGapMs) return false
  lastBalloonAt.set(key, now)
  try {
    if (process.platform === "win32") {
      const safeTitle = title.replace(/'/g, "''")
      const safeBody = body.replace(/'/g, "''").replace(/\r?\n/g, " ").slice(0, 400)
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        "$n = New-Object System.Windows.Forms.NotifyIcon;",
        "$n.Icon = [System.Drawing.SystemIcons]::Information;",
        `$n.BalloonTipTitle = '${safeTitle}';`,
        `$n.BalloonTipText = '${safeBody}';`,
        "$n.Visible = $true;",
        "[System.Media.SystemSounds]::Exclamation.Play();",
        "$n.ShowBalloonTip(3000);",
        "Start-Sleep -Seconds 3;",
        "$n.Dispose();",
      ].join(" ")
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
        },
        () => {},
      )
      child.on("error", () => {})
      return true
    }
    if (process.platform === "darwin") {
      const child = execFile(
        "osascript",
        [
          "-e",
          'display notification "' + body.replace(/"/g, '\\"') + '" with title "' + title.replace(/"/g, '\\"') + '"',
        ],
        () => {},
      )
      child.on("error", () => {})
      return true
    }
    const child = execFile("notify-send", [title, body], () => {})
    child.on("error", () => {})
    return true
  } catch {
    return false
  }
}

export function shouldNotify(event: AgentEvent, config: NotificationConfig): boolean {
  if (!config.enabled) return false
  if (event.type === "tool_execution_end" && event.isError) return config.onToolError
  if (event.type === "permission_request") return config.onPermissionRequest
  if (event.type === "agent_end") return config.onAgentEnd
  return false
}

export function notifyForEvent(event: AgentEvent, config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG): void {
  if (!shouldNotify(event, config)) return
  if (event.type === "tool_execution_end") osNotify("TRAYAMBAK – Tool Error", event.toolName + " failed")
  else if (event.type === "permission_request") notifyPermissionRequest(event.tool, event.reason)
  else if (event.type === "agent_end") osNotify("TRAYAMBAK – Done", "Agent finished")
}

export function createNotificationSink(
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => notifyForEvent(event, config)
}

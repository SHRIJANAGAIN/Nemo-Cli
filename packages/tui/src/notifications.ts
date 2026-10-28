/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFile, execFileSync } from "child_process"
import type { AgentEvent } from "../../protocol/src/index.js"
import { envFlag, envString } from "../../core/src/env_read.js"
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
  const termProgram = envString("TERM_PROGRAM")
  if (!termProgram) return false
  return OSC9_TERMINALS.has(termProgram)
}

export function isTmux(): boolean {
  // Inside a tmux session OSC-777 notifications are rewritten by the terminal
  // multiplexer, so the escape is suppressed. The literal was `!!process.env.TMUX`,
  // where `TMUX=""` already read as false, so the flag default is false.
  return envFlag(
    "TMUX",
    /*fallbackWhenUnset*/ false,
  )
}

function escapeTmuxPayload(message: string): string {
  return message.replace(/\x1b/g, "\x1b\x1b")
}

/** Notification text reaches a terminal escape sequence and two shells, so it
 *  may not carry control bytes. */
function printableLine(input: string, max = 400): string {
  return input
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

const NOTIFY_TITLE_ENV = "NEMO_NOTIFY_TITLE"
const NOTIFY_BODY_ENV = "NEMO_NOTIFY_BODY"

/** Payload goes through the environment so PowerShell never parses it as code. */
function notifyEnv(title: string, body: string): NodeJS.ProcessEnv {
  return { ...process.env, [NOTIFY_TITLE_ENV]: printableLine(title, 120), [NOTIFY_BODY_ENV]: printableLine(body) }
}

function powershellScript(body: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms; ${body}`
}

function balloonScript(durationMs: number, sleepClause: string): string {
  return powershellScript(
    [
      "Add-Type -AssemblyName System.Drawing;",
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      `$n.BalloonTipTitle = $env:${NOTIFY_TITLE_ENV};`,
      `$n.BalloonTipText = $env:${NOTIFY_BODY_ENV};`,
      "$n.Visible = $true;",
      "[System.Media.SystemSounds]::Exclamation.Play();",
      `$n.ShowBalloonTip(${durationMs});`,
      sleepClause,
      "$n.Dispose();",
    ].join(" "),
  )
}

/** osascript receives the strings as argv — no string interpolation to escape. */
function osascriptArgs(title: string, body: string): string[] {
  return [
    "-e",
    "on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run",
    printableLine(title, 120),
    printableLine(body),
  ]
}

export function osc9Notify(title: string, body: string): boolean {
  if (!process.stdout.isTTY) return false
  try {
    const message = printableLine(`${title}: ${body}`)
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
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powershellScript(
            `[System.Windows.Forms.MessageBox]::Show($env:${NOTIFY_BODY_ENV}, $env:${NOTIFY_TITLE_ENV}, "OK", "Information")`,
          ),
        ],
        { env: notifyEnv(title, body), encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else if (process.platform === "darwin") {
      execFileSync("osascript", osascriptArgs(title, body), {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } else {
      execFileSync("notify-send", ["--", printableLine(title, 120), printableLine(body)], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
    }
  } catch {}
}

export function notifyPermissionRequest(tool: string, body: string): void {
  const title = "NEMO – Approval Required"
  if (process.platform === "win32") {
    const text = `${tool} needs approval: ${body}`
    const command = balloonScript(2000, "Start-Sleep -Milliseconds 2000;")
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: notifyEnv(title, text),
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
 * NEMO_NO_NOTIFY=1 disables it entirely.
 */
export function notifyBalloon(key: string, title: string, body: string, minGapMs = 4000): boolean {
  // The documented spelling was exactly "1". envFlag additionally honours 0/off/
    // no/true/on/yes and falls back on anything else, so `NEMO_NO_NOTIFY=0`
    // (the obvious way to turn it OFF) can no longer mean "notifications on".
    if (envFlag("NEMO_NO_NOTIFY", /*fallbackWhenUnset*/ false)) return false
  const now = Date.now()
  if (now - (lastBalloonAt.get(key) ?? 0) < minGapMs) return false
  lastBalloonAt.set(key, now)
  try {
    if (process.platform === "win32") {
      const script = balloonScript(3000, "Start-Sleep -Seconds 3;")
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: notifyEnv(title, body),
          windowsHide: true,
        },
        () => {},
      )
      child.on("error", () => {})
      return true
    }
    if (process.platform === "darwin") {
      const child = execFile("osascript", osascriptArgs(title, body), () => {})
      child.on("error", () => {})
      return true
    }
    const child = execFile("notify-send", ["--", printableLine(title, 120), printableLine(body)], () => {})
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
  if (event.type === "tool_execution_end") osNotify("NEMO – Tool Error", event.toolName + " failed")
  else if (event.type === "permission_request") notifyPermissionRequest(event.tool, event.reason)
  else if (event.type === "agent_end") osNotify("NEMO – Done", "Agent finished")
}

export function createNotificationSink(
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => notifyForEvent(event, config)
}

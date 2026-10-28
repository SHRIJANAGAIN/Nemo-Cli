/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { execFileSync } from "child_process"
import type { AgentEvent } from "../../../packages/protocol/src/index.js"

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

const NOTIFY_TITLE_ENV = "NEMO_NOTIFY_TITLE"
const NOTIFY_BODY_ENV = "NEMO_NOTIFY_BODY"

/** Notification text reaches two shells, so it may not carry control bytes. */
function printableLine(input: string, max = 400): string {
  return input
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

/** Payload goes through the environment so PowerShell never parses it as code. */
function notifyEnv(title: string, body: string): NodeJS.ProcessEnv {
  return { ...process.env, [NOTIFY_TITLE_ENV]: printableLine(title, 120), [NOTIFY_BODY_ENV]: printableLine(body) }
}

function osNotify(title: string, body: string): void {
  try {
    if (process.platform === "win32") {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:${NOTIFY_BODY_ENV}, $env:${NOTIFY_TITLE_ENV}, "OK", "Information")`,
        ],
        {
          env: notifyEnv(title, body),
          encoding: "utf8",
          timeout: 1500,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
    } else if (process.platform === "darwin") {
      execFileSync(
        "osascript",
        [
          "-e",
          "on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run",
          printableLine(title, 120),
          printableLine(body),
        ],
        { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else {
      execFileSync("notify-send", ["--", printableLine(title, 120), printableLine(body)], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
    }
  } catch {
    /* fallback silent */
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
  if (event.type === "tool_execution_end") {
    osNotify("Nemo – Tool Error", `${event.toolName} failed`)
  } else if (event.type === "permission_request") {
    osNotify("Nemo – Approval Required", `${event.tool} needs approval`)
  } else if (event.type === "agent_end") {
    osNotify("Nemo – Done", "Agent finished")
  }
}

export function createNotificationSink(
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => notifyForEvent(event, config)
}

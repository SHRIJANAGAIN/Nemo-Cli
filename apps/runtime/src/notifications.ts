/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
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

function osNotify(title: string, body: string): void {
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
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("${safeBody}", "${safeTitle}", "OK", "Information")`,
        ],
        { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else if (process.platform === "darwin") {
      execFileSync(
        "osascript",
        ["-e", `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`],
        { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
      )
    } else {
      execFileSync("notify-send", [title, body], {
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
    osNotify("Trayambak – Tool Error", `${event.toolName} failed`)
  } else if (event.type === "permission_request") {
    osNotify("Trayambak – Approval Required", `${event.tool} needs approval`)
  } else if (event.type === "agent_end") {
    osNotify("Trayambak – Done", "Agent finished")
  }
}

export function createNotificationSink(
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => notifyForEvent(event, config)
}

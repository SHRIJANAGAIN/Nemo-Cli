/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Application-level events used to coordinate UI actions.
 *
 * This is a TypeScript port of the TRAYAMBAK TUI AppEvent enum.
 * Events are the internal message bus between UI components and the top-level App loop.
 */

export interface TrayambakConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  cwd?: string
}

export interface PermissionRequest {
  id: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

export interface PermissionResponse {
  id: string
  allowed: boolean
}

export interface ApprovalRequest {
  id: string
  title: string
  body: string
  toolName: string
  args: unknown
  choices: Array<{ label: string; value: string }>
  createdAt: number
}

export interface ServerNotification {
  type: string
  threadId?: string
  itemId?: string
  [key: string]: unknown
}

export interface ServerRequest {
  type: string
  requestId: string
  threadId?: string
  [key: string]: unknown
}

export type ExitMode = "normal" | "fatal" | "user_requested"

export interface AppExitInfo {
  exitReason: { kind: ExitMode; message?: string }
  tokenUsage: { totalTokens: number }
  threadId?: string
  resumeHint?: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Frame {
  size: { width: number; height: number }
  viewport: Rect
}

export interface DrawCallback {
  (frame: Frame): void
}

export interface TuiEvent {
  type: "key" | "paste" | "resize" | "draw" | "resume"
  data?: unknown
}

export type AppEvent =
  | { type: "Init" }
  | { type: "Shutdown" }
  | { type: "Exit"; mode: ExitMode }
  | { type: "Render" }
  | { type: "KeyEvent"; key: string; code: number; modifiers: number }
  | { type: "PasteEvent"; text: string }
  | { type: "ResizeEvent"; width: number; height: number }
  | { type: "DrawEvent"; frame: Frame }
  | { type: "ResumeEvent" }
  | { type: "TickEvent" }
  | { type: "PermissionRequestEvent"; request: PermissionRequest }
  | { type: "PermissionResponseEvent"; response: PermissionResponse }
  | { type: "ApprovalRequestEvent"; request: ApprovalRequest }
  | { type: "ApprovalResponseEvent"; requestId: string; choice: string | null }
  | { type: "ServerNotificationEvent"; notification: ServerNotification }
  | { type: "ServerRequestEvent"; request: ServerRequest }
  | { type: "ThreadStartedEvent"; threadId: string }
  | { type: "ThreadCompletedEvent"; threadId: string; result?: unknown }
  | { type: "ThreadFailedEvent"; threadId: string; error: string }
  | { type: "AgentMessageDeltaEvent"; threadId: string; delta: string }
  | { type: "AgentMessageCompletedEvent"; threadId: string; message: unknown }
  | { type: "ItemStartedEvent"; threadId: string; itemId: string; itemType: string }
  | { type: "ItemCompletedEvent"; threadId: string; itemId: string }
  | { type: "ItemFailedEvent"; threadId: string; itemId: string; error: string }
  | { type: "TurnStartedEvent"; threadId: string }
  | { type: "TurnCompletedEvent"; threadId: string }
  | { type: "TurnFailedEvent"; threadId: string; error: string }
  | { type: "ErrorEvent"; error: Error }
  | { type: "FatalErrorEvent"; error: Error }
  | { type: "ConfigUpdateEvent"; config: Partial<TrayambakConfig> }
  | { type: "ThemeChangeEvent"; theme: string }
  | { type: "NotificationEvent"; notification: { title: string; body: string; level: "info" | "warning" | "error" } }
  | { type: "UserInputEvent"; text: string }
  | { type: "CommandEvent"; command: string; args?: string[] }
  | { type: "SlashCommandEvent"; command: string; args?: string }
  | { type: "BackgroundTaskEvent"; taskId: string; status: "started" | "completed" | "failed" }
  | { type: "ModelSwitchEvent"; model: string }
  | { type: "ContextUpdateEvent"; context: { tokensUsed: number; tokensMax: number } }

export type AppEventHandler = (event: AppEvent) => void

export interface TerminalSize {
  width: number
  height: number
}

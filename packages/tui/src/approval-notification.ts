/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { notifyPermissionRequest, osNotify } from "./notifications"

export type ApprovalChoice = "approve" | "deny" | "approve_session" | "dont_ask_again" | "edit"

export type PermissionMode = "read-only" | "ask" | "auto-approve" | "full-access"

export interface ApprovalRequest {
  id: string
  title: string
  body: string
  toolName: string
  args: unknown
  choices: Array<{ label: string; value: ApprovalChoice }>
  createdAt: number
}

export interface Notification {
  id: string
  title: string
  body: string
  kind: "info" | "warning" | "error" | "success"
  createdAt: number
  dismissed?: boolean
}

export const DEFAULT_APPROVAL_CHOICES: Array<{ label: string; value: ApprovalChoice }> = [
  { label: "Approve", value: "approve" },
  { label: "Approve for session", value: "approve_session" },
  { label: "Don't ask again", value: "dont_ask_again" },
  { label: "Deny", value: "deny" },
]

export class ApprovalManager {
  private queue: ApprovalRequest[] = []
  private listeners: Array<(approvals: ApprovalRequest[]) => void> = []
  private resolvers: Map<
    string,
    { promise: Promise<ApprovalChoice | null>; resolve: (value: ApprovalChoice | null) => void }
  > = new Map()
  private autoApprove = false
  private readOnly = false
  private sessionApprovedTools: Set<string> = new Set()
  private neverAskTools: Set<string> = new Set()

  setAutoApprove(enabled: boolean) {
    this.autoApprove = enabled
    if (enabled) this.readOnly = false
  }

  isAutoApprove() {
    return this.autoApprove
  }

  setReadOnly(enabled: boolean) {
    this.readOnly = enabled
    if (enabled) this.autoApprove = false
  }

  isReadOnly() {
    return this.readOnly
  }

  isSessionApproved(toolName: string): boolean {
    return this.sessionApprovedTools.has(toolName)
  }

  markSessionApproved(toolName: string) {
    this.sessionApprovedTools.add(toolName)
  }

  isNeverAsk(toolName: string): boolean {
    return this.neverAskTools.has(toolName)
  }

  markNeverAsk(toolName: string) {
    this.neverAskTools.add(toolName)
    this.sessionApprovedTools.add(toolName)
  }

  requestApproval(
    title: string,
    body: string,
    toolName: string,
    args: unknown,
    choices: Array<{ label: string; value: ApprovalChoice }> = DEFAULT_APPROVAL_CHOICES,
  ): Promise<ApprovalChoice | null> {
    if (this.readOnly) {
      try {
        osNotify("NEMO – READ-ONLY", toolName + " blocked (read-only mode)")
      } catch {}
      const id = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const req: ApprovalRequest = {
        id,
        title: title + " (blocked – read-only)",
        body: body + "\n\nREAD-ONLY mode blocks writes. Switch with Ctrl+P or /permissions ask.",
        toolName,
        args,
        choices: [{ label: "Denied (read-only)", value: "deny" }],
        createdAt: Date.now(),
      }
      this.queue.push(req)
      this.emitChange()
      setTimeout(() => {
        this.resolveApproval(id, "deny")
      }, 50)
      return Promise.resolve("deny" as ApprovalChoice)
    }
    if (this.autoApprove) return Promise.resolve("approve")
    if (this.sessionApprovedTools.has(toolName)) return Promise.resolve("approve")
    if (this.neverAskTools.has(toolName)) return Promise.resolve("approve")

    const id = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const request: ApprovalRequest = {
      id,
      title,
      body,
      toolName,
      args,
      choices,
      createdAt: Date.now(),
    }

    this.queue.push(request)
    this.emitChange()
    try {
      notifyPermissionRequest(toolName, body)
    } catch {}

    let resolveFn: (value: ApprovalChoice | null) => void = () => {}
    const promise = new Promise<ApprovalChoice | null>((resolve) => {
      resolveFn = resolve
    })
    this.resolvers.set(id, { promise, resolve: resolveFn })
    return promise
  }

  resolveApproval(id: string, value: ApprovalChoice | null) {
    const request = this.queue.find((r) => r.id === id)
    const toolName = request?.toolName
    const resolver = this.resolvers.get(id)

    if (resolver) {
      this.resolvers.delete(id)
      resolver.resolve(value)
    }
    this.queue = this.queue.filter((r) => r.id !== id)
    this.emitChange()

    const choiceLabel =
      value === "approve"
        ? "Approved"
        : value === "approve_session"
          ? "Approved for session"
          : value === "dont_ask_again"
            ? "Approved — don’t ask again"
            : "Denied"
    try {
      osNotify("NEMO – " + choiceLabel, (request?.title ?? "Approval") + (toolName ? " (" + toolName + ")" : ""))
    } catch {}

    if (value === "approve_session" && toolName) {
      this.sessionApprovedTools.add(toolName)
    } else if (value === "dont_ask_again" && toolName) {
      this.neverAskTools.add(toolName)
      this.sessionApprovedTools.add(toolName)
    }
  }

  cancelAll(_reason: string) {
    this.queue.forEach((r) => {
      const resolver = this.resolvers.get(r.id)
      if (resolver) {
        this.resolvers.delete(r.id)
        resolver.resolve(null)
      }
    })
    this.queue = []
    this.emitChange()
  }

  getPendingApprovals(): ApprovalRequest[] {
    return [...this.queue]
  }

  /** Attach to the promise of an already-pending approval request. */
  awaitResolution(id: string): Promise<ApprovalChoice | null> {
    const entry = this.resolvers.get(id)
    return entry ? entry.promise : Promise.resolve(null)
  }

  hasPendingApprovals(): boolean {
    return this.queue.length > 0
  }

  subscribe(listener: (approvals: ApprovalRequest[]) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private emitChange() {
    const snapshot = this.getPendingApprovals()
    this.listeners.forEach((l) => {
      try {
        l(snapshot)
      } catch {
        /* subscriber errors must not break the queue */
      }
    })
  }
}

export class NotificationDispatcher {
  private notifications: Notification[] = []
  private listeners: Array<(notifications: Notification[]) => void> = []

  private generateId(): string {
    return `notif-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  send(title: string, body: string, kind: Notification["kind"] = "info") {
    const notification: Notification = {
      id: this.generateId(),
      title,
      body,
      kind,
      createdAt: Date.now(),
    }
    this.notifications.push(notification)
    this.notifyListeners()
    return notification
  }

  dismiss(id: string) {
    this.notifications = this.notifications.map((n) => (n.id === id ? { ...n, dismissed: true } : n))
    this.notifications = this.notifications.filter((n) => !n.dismissed)
    this.notifyListeners()
  }

  dismissAll() {
    this.notifications = []
    this.notifyListeners()
  }

  getActiveNotifications(): Notification[] {
    return this.notifications.filter((n) => !n.dismissed)
  }

  subscribe(listener: (notifications: Notification[]) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private notifyListeners() {
    const active = this.getActiveNotifications()
    this.listeners.forEach((l) => l(active))
  }

  info(title: string, body: string) {
    return this.send(title, body, "info")
  }

  success(title: string, body: string) {
    return this.send(title, body, "success")
  }

  warning(title: string, body: string) {
    return this.send(title, body, "warning")
  }

  error(title: string, body: string) {
    return this.send(title, body, "error")
  }
}

export const globalApprovalManager = new ApprovalManager()
export const globalNotificationDispatcher = new NotificationDispatcher()

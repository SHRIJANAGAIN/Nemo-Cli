/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * approvalFor() — the single decision point for tool approvals.
 *
 * Wraps the protocol permission engine (`evaluatePermission`) with the
 * core denial tracker, so every approval decision in the process flows
 * through one exhaustively-switched function: allow / ask / deny, with a
 * `default` that fails toward asking. Destructive operations resolve to
 * `ask` unless danger mode is explicit; denials are recorded for
 * telemetry and backoff. Pure and deterministic (no network, no clock
 * beyond the tracker's timestamp).
 */

import {
  DEFAULT_PERMISSIONS,
  evaluatePermission,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionUIMode,
} from "../../../packages/protocol/src/index.js"

/** Denial tracker — counts denials per tool for telemetry and backoff. */
export class DenialTracker {
  private readonly counts = new Map<string, number>()
  private lastDeniedAt = 0

  /** Record a denial. Returns the new count for that tool. */
  record(tool: string): number {
    const next = (this.counts.get(tool) ?? 0) + 1
    this.counts.set(tool, next)
    this.lastDeniedAt = Date.now()
    return next
  }

  count(tool: string): number {
    return this.counts.get(tool) ?? 0
  }

  total(): number {
    let sum = 0
    for (const n of this.counts.values()) sum += n
    return sum
  }

  getLastDeniedAt(): number {
    return this.lastDeniedAt
  }

  reset(tool?: string): void {
    if (tool === undefined) {
      this.counts.clear()
      this.lastDeniedAt = 0
      return
    }
    this.counts.delete(tool)
  }
}

export type ApprovalDecision = "allow" | "ask" | "deny"

export interface ApprovalOptions {
  uiMode?: PermissionUIMode
  config?: PermissionConfig
  tracker?: DenialTracker
  /** Explicit danger mode (full-access toggle): ask becomes allow. Deny still denies. */
  danger?: boolean
}

export interface ApprovalOutcome {
  decision: ApprovalDecision
  source: PermissionDecision["source"]
  layer: PermissionDecision["layer"]
  rule: PermissionDecision["rule"]
}

export function approvalFor(tool: string, args: unknown, opts: ApprovalOptions = {}): ApprovalOutcome {
  const config = opts.config ?? DEFAULT_PERMISSIONS
  const decision = evaluatePermission(tool, args, config, { uiMode: opts.uiMode })
  let verdict: ApprovalDecision
  switch (decision.action) {
    case "allow":
      verdict = "allow"
      break
    case "ask":
      verdict = opts.danger === true ? "allow" : "ask"
      break
    case "deny":
      verdict = "deny"
      break
    default:
      // Exhaustive switch with a fail-toward-asking default: an unknown
      // future action must never silently allow.
      verdict = "ask"
      break
  }
  if (verdict === "deny") opts.tracker?.record(tool)
  return { decision: verdict, source: decision.source, layer: decision.layer, rule: decision.rule }
}

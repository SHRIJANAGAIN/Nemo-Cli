/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { State, RoleContext, ControllerState } from "./state.js"
import { ROLES } from "./roles.js"

export interface RouteDecision {
  nextState: State
  nextRole: string
}

function hasOpenQuestions(ctx: RoleContext): boolean {
  return ctx.openQuestions.length > 0
}

function hasFailedSteps(ctx: RoleContext): boolean {
  return ctx.failedSteps.length > 0
}

function hasUntestedRequirements(ctx: RoleContext): boolean {
  return ctx.requirements.some((req) => !ctx.tests.some((t) => t.includes(req)))
}

function repetitionGuard(ctx: RoleContext): boolean {
  return ctx.attempt >= 3 || ctx.strategyChanges >= 2
}

export function route(state: ControllerState): RouteDecision {
  const ctx = state.context
  const current = ctx.currentState

  if (current === "DONE" || current === "ESCALATE") {
    return { nextState: current, nextRole: ctx.role }
  }

  if (current === "UNDERSTAND") {
    if (hasOpenQuestions(ctx) && !repetitionGuard(ctx)) {
      return { nextState: "RESEARCH", nextRole: "researcher" }
    }
    if (repetitionGuard(ctx)) {
      return { nextState: "ESCALATE", nextRole: "escalator" }
    }
    return { nextState: "PLAN", nextRole: "planner" }
  }

  if (current === "RESEARCH") {
    if (hasFailedSteps(ctx) && repetitionGuard(ctx)) {
      return { nextState: "ESCALATE", nextRole: "escalator" }
    }
    return { nextState: "PLAN", nextRole: "planner" }
  }

  if (current === "PLAN") {
    if (repetitionGuard(ctx)) {
      return { nextState: "ESCALATE", nextRole: "escalator" }
    }
    return { nextState: "EXECUTE", nextRole: "implementer" }
  }

  if (current === "EXECUTE") {
    if (hasFailedSteps(ctx)) {
      if (repetitionGuard(ctx)) {
        return { nextState: "ESCALATE", nextRole: "escalator" }
      }
      return { nextState: "DEBUG", nextRole: "debugger" }
    }
    return { nextState: "VERIFY", nextRole: "reviewer" }
  }

  if (current === "DEBUG") {
    if (repetitionGuard(ctx)) {
      return { nextState: "ESCALATE", nextRole: "escalator" }
    }
    return { nextState: "EXECUTE", nextRole: "implementer" }
  }

  if (current === "VERIFY") {
    if (hasUntestedRequirements(ctx)) {
      return { nextState: "TEST", nextRole: "tester" }
    }
    return { nextState: "DONE", nextRole: "completer" }
  }

  if (current === "TEST") {
    if (hasFailedSteps(ctx)) {
      return { nextState: "DEBUG", nextRole: "debugger" }
    }
    return { nextState: "DONE", nextRole: "completer" }
  }

  return { nextState: "ESCALATE", nextRole: "escalator" }
}

export function getRolePrompt(role: string): string {
  return ROLES[role]?.prompt ?? ROLES.escalator.prompt
}

export function getRoleSystemPrompt(role: string): string {
  return ROLES[role]?.systemPrompt ?? ROLES.escalator.systemPrompt
}

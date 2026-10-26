/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type Role =
  | "analyzer"
  | "planner"
  | "coder"
  | "tester"
  | "debugger"
  | "critic"
  | "finalizer"
  | "researcher"
  | "security_reviewer"
  | "optimizer"
  | "skill_builder"
  | "memory_manager"
  | "implementer"
  | "reviewer"
  | "completer"
  | "escalator"

export interface RoleContext {
  role: Role
  goal: string
  requirements: string[]
  constraints: string[]
  plan: string[]
  completedSteps: string[]
  failedSteps: string[]
  observations: string[]
  evidence: string[]
  openQuestions: string[]
  assumptions: string[]
  tests: string[]
  currentState: string
  attempt: number
  lastError?: string
  strategyChanges: number
}

export type State =
  | "START"
  | "UNDERSTAND"
  | "RESEARCH"
  | "PLAN"
  | "IMPLEMENT"
  | "EXECUTE"
  | "TEST"
  | "VERIFY"
  | "DEBUG"
  | "CRITIQUE"
  | "FIX"
  | "FINALIZE"
  | "DONE"
  | "ESCALATE"

export interface ControllerState {
  state: State
  role: Role
  context: RoleContext
  searchBudgetUsed: number
  searchBudgetLimit: number
  repetitionCount: number
  progressHistory: Array<{ attempt: number; error?: string; passed?: boolean }>
}

export function createInitialContext(goal: string): RoleContext {
  return {
    role: "analyzer",
    goal,
    requirements: [],
    constraints: [],
    plan: [],
    completedSteps: [],
    failedSteps: [],
    observations: [],
    evidence: [],
    openQuestions: [],
    assumptions: [],
    tests: [],
    currentState: "UNDERSTAND",
    attempt: 0,
    strategyChanges: 0,
  }
}

export function createInitialControllerState(goal: string): ControllerState {
  return {
    state: "START",
    role: "analyzer",
    context: createInitialContext(goal),
    searchBudgetUsed: 0,
    searchBudgetLimit: 10000,
    repetitionCount: 0,
    progressHistory: [],
  }
}

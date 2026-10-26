/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ControllerState, RoleContext } from "./state.js"
import { createInitialControllerState } from "./state.js"
import { route, getRolePrompt } from "./router.js"

export interface ControllerResult {
  state: ControllerState
  output: string
  shouldContinue: boolean
}

export class AgentController {
  readonly state: ControllerState

  constructor(goal: string) {
    this.state = createInitialControllerState(goal)
  }

  step(observation: string, passed?: boolean, error?: string): ControllerResult {
    this.state.context.observations.push(observation)
    if (error) {
      this.state.context.failedSteps.push(error)
      this.state.progressHistory.push({ attempt: this.state.context.attempt, error, passed: false })
    } else if (passed !== undefined) {
      this.state.progressHistory.push({ attempt: this.state.context.attempt, passed })
    }

    const decision = route(this.state)
    this.state.state = decision.nextState
    this.state.role = decision.nextRole as typeof this.state.role
    this.state.context.role = decision.nextRole as typeof this.state.context.role
    this.state.context.currentState = decision.nextState

    if (error) {
      this.state.context.attempt += 1
    }

    const output = `[${decision.nextRole}] ${getRolePrompt(decision.nextRole)}`
    const shouldContinue = this.state.state !== "DONE" && this.state.state !== "ESCALATE"

    return { state: this.state, output, shouldContinue }
  }

  incrementRepetition(): void {
    this.state.repetitionCount += 1
  }

  resetRepetition(): void {
    this.state.repetitionCount = 0
  }

  incrementStrategyChange(): void {
    this.state.context.strategyChanges += 1
  }

  useSearchBudget(count: number): boolean {
    if (this.state.searchBudgetUsed + count > this.state.searchBudgetLimit) {
      return false
    }
    this.state.searchBudgetUsed += count
    return true
  }

  addEvidence(evidence: string): void {
    this.state.context.evidence.push(evidence)
  }

  addRequirement(req: string): void {
    this.state.context.requirements.push(req)
  }

  addAssumption(assumption: string): void {
    this.state.context.assumptions.push(assumption)
  }

  addTest(test: string): void {
    this.state.context.tests.push(test)
  }

  getContext(): RoleContext {
    return this.state.context
  }
}

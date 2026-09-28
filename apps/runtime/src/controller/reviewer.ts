/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { RoleContext } from "./state.js"

export interface ReviewResult {
  passed: boolean
  score: number
  issues: string[]
  suggestions: string[]
}

export class Reviewer {
  reviewRequirements(context: RoleContext): ReviewResult {
    const issues: string[] = []
    const suggestions: string[] = []

    if (context.requirements.length === 0) {
      issues.push("No requirements defined")
      suggestions.push("Extract requirements from the goal before planning")
    }

    const untested = context.requirements.filter((req) => !context.tests.some((t) => t.includes(req)))
    if (untested.length > 0) {
      issues.push(`${untested.length} requirement(s) lack tests: ${untested.join(", ")}`)
      suggestions.push("Add tests for all requirements")
    }

    const uncovered = context.tests.filter((t) => !context.requirements.some((r) => t.includes(r)))
    if (uncovered.length > 0) {
      issues.push(`${uncovered.length} test(s) don't map to requirements: ${uncovered.join(", ")}`)
      suggestions.push("Ensure all tests cover specific requirements")
    }

    const score = Math.max(0, 100 - issues.length * 20)
    return { passed: issues.length === 0, score, issues, suggestions }
  }

  reviewCode(_code: string, _language: string): ReviewResult {
    const issues: string[] = []
    const suggestions: string[] = []

    if (_code.includes("any")) {
      issues.push("Usage of 'any' type detected")
      suggestions.push("Replace 'any' with specific types for better type safety")
    }

    if (_code.includes("console.log")) {
      issues.push("Console.log statements found")
      suggestions.push("Remove console.log statements or use proper logging")
    }

    const score = Math.max(0, 100 - issues.length * 15)
    return { passed: issues.length === 0, score, issues, suggestions }
  }

  reviewPlan(plan: string[]): ReviewResult {
    const issues: string[] = []
    const suggestions: string[] = []

    if (plan.length === 0) {
      issues.push("Plan is empty")
      suggestions.push("Create a detailed plan with at least 3 steps")
    }

    const circular = plan.some((step, i) => plan.some((other, j) => i !== j && step === other))
    if (circular) {
      issues.push("Plan contains circular dependencies")
      suggestions.push("Remove duplicate or circular steps")
    }

    const score = Math.max(0, 100 - issues.length * 25)
    return { passed: issues.length === 0, score, issues, suggestions }
  }
}

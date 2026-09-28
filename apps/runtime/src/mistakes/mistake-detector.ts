/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type MistakeType =
  | "REASONING_ERROR"
  | "TOOL_ERROR"
  | "API_ERROR"
  | "SYNTAX_ERROR"
  | "REQUIREMENT_ERROR"
  | "ASSUMPTION_ERROR"
  | "ENVIRONMENT_ERROR"
  | "TESTING_ERROR"
  | "RESEARCH_ERROR"
  | "REPETITION_ERROR"
  | "DEPENDENCY_ERROR"
  | "SECURITY_ERROR"

export interface MistakeRecord {
  id: string
  task: string
  action: string
  observation: string
  error: string
  type: MistakeType
  rootCause: string
  fix: string
  verification: string
  preventionRule: string
  timestamp: string
}

export class MistakeDetector {
  private readonly records: MistakeRecord[] = []
  private readonly typeCounts = new Map<MistakeType, number>()

  record(params: {
    task: string
    action: string
    observation: string
    error: string
    type: MistakeType
    rootCause: string
    fix: string
    verification: string
  }): MistakeRecord {
    const preventionRule = this.generatePreventionRule(params)
    const record: MistakeRecord = {
      id: `mistake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ...params,
      preventionRule,
      timestamp: new Date().toISOString(),
    }
    this.records.push(record)
    const current = this.typeCounts.get(params.type) ?? 0
    this.typeCounts.set(params.type, current + 1)
    return record
  }

  getByType(type: MistakeType): MistakeRecord[] {
    return this.records.filter((r) => r.type === type)
  }

  getMostFrequent(): { type: MistakeType; count: number } | null {
    let top: { type: MistakeType; count: number } | null = null
    for (const [type, count] of this.typeCounts.entries()) {
      if (!top || count > top.count) top = { type, count }
    }
    return top
  }

  getPreventionRules(): string[] {
    return Array.from(new Set(this.records.map((r) => r.preventionRule)))
  }

  private generatePreventionRule(params: { type: MistakeType; rootCause: string; fix: string }): string {
    const templates: Record<MistakeType, string> = {
      REASONING_ERROR: `Verify reasoning steps before acting. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      TOOL_ERROR: `Check tool availability and arguments before calling. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      API_ERROR: `Inspect installed version and official docs before using APIs. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      SYNTAX_ERROR: `Validate syntax before execution. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      REQUIREMENT_ERROR: `Re-read requirements before implementing. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      ASSUMPTION_ERROR: `State assumptions explicitly and verify them. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      ENVIRONMENT_ERROR: `Check environment and dependencies first. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      TESTING_ERROR: `Run targeted tests after changes. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      RESEARCH_ERROR: `Search authoritative docs for unfamiliar APIs. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      REPETITION_ERROR: `Change strategy when same failure repeats. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      DEPENDENCY_ERROR: `Check installed package versions. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
      SECURITY_ERROR: `Validate inputs and avoid hardcoded secrets. Root cause: ${params.rootCause}. Fix: ${params.fix}`,
    }
    return templates[params.type] ?? `Review action before retry. Root cause: ${params.rootCause}. Fix: ${params.fix}`
  }
}

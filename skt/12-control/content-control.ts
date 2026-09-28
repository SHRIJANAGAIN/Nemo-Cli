/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Unified Content Control System.
 * Integrates: Repetition Detection (4 levels) + Hallucination Control + Verification Pipeline.
 *
 * Flow: GENERATE → DETECT REPETITION → DETECT HALLUCINATION → VERIFY → POINTS/PENALTY
 */

import { RepetitionDetector, RepetitionResult, RepetitionConfig } from "./repetition.js"
import { HallucinationDetector, HallucinationResult, HallucinationConfig } from "./hallucination.js"
import { VerificationPipeline, VerificationReport, VerificationConfig } from "./verification.js"
import { PointsSystem, PointsState } from "./points.js"

export interface ContentControlConfig {
  repetition?: Partial<RepetitionConfig>
  hallucination?: Partial<HallucinationConfig>
  verification?: Partial<VerificationConfig>
  cwd: string
}

export interface ContentControlResult {
  shouldCut: boolean
  shouldRetry: boolean
  repetition: RepetitionResult
  hallucination: HallucinationResult
  pointsAwarded: number
  pointsDeducted: number
  message: string
}

export class ContentControl {
  private repetitionDetector: RepetitionDetector
  private hallucinationDetector: HallucinationDetector
  private pointsSystem: PointsSystem
  private config: ContentControlConfig
  private taskId: string
  private taskName: string
  private taskDescription: string
  private taskType: "easy" | "normal" | "medium" | "high" | "critical"

  constructor(
    config: ContentControlConfig,
    taskId: string,
    taskName: string,
    taskDescription: string,
    taskType: "easy" | "normal" | "medium" | "high" | "critical" = "normal",
  ) {
    this.config = config
    this.taskId = taskId
    this.taskName = taskName
    this.taskDescription = taskDescription
    this.taskType = taskType
    this.repetitionDetector = new RepetitionDetector(config.repetition)
    this.hallucinationDetector = new HallucinationDetector(config.hallucination)
    this.pointsSystem = new PointsSystem()
  }

  /**
   * Feed a delta and check for repetition + hallucination.
   * Returns ContentControlResult with shouldCut/shouldRetry decisions.
   */
  ingest(delta: string): ContentControlResult {
    const repetition = this.repetitionDetector.ingest(delta)
    const hallucination = this.hallucinationDetector.analyze(delta)

    let shouldCut = false
    let shouldRetry = false
    const pointsAwarded = 0
    let pointsDeducted = 0
    let message = ""

    // Handle repetition
    if (repetition.level > 0) {
      shouldCut = true
      shouldRetry = true
      pointsDeducted = this.getPenaltyPoints(repetition.severity)
      message = `REPETITION DETECTED (Level ${repetition.level}): ${repetition.detail}`
      this.pointsSystem.penalize(
        this.taskId,
        this.taskName,
        this.taskDescription,
        this.taskType,
        `Repetition L${repetition.level}: ${repetition.detail}`,
        "repetition",
        undefined,
        undefined,
        delta,
      )
    }

    // Handle hallucination
    if (hallucination.isHallucination) {
      shouldCut = true
      shouldRetry = true
      pointsDeducted += this.getPenaltyPoints("high")
      message = `HALLUCINATION DETECTED: ${hallucination.detail}`
      this.pointsSystem.penalize(
        this.taskId,
        this.taskName,
        this.taskDescription,
        this.taskType,
        `Hallucination: ${hallucination.detail}`,
        "hallucination",
        undefined,
        undefined,
        delta,
      )
    }

    return { shouldCut, shouldRetry, repetition, hallucination, pointsAwarded, pointsDeducted, message }
  }

  /**
   * Run the verification pipeline after generation completes.
   */
  async verify(): Promise<VerificationReport> {
    const pipeline = new VerificationPipeline({
      cwd: this.config.cwd,
      steps: ["typecheck", "unit_test", "build"],
    })
    return pipeline.run()
  }

  /**
   * Award points for successful completion.
   */
  awardPoints(reason: string, userFeedback?: string, assistantOutput?: string): void {
    this.pointsSystem.award(
      this.taskId,
      this.taskName,
      this.taskDescription,
      this.taskType,
      reason,
      userFeedback,
      assistantOutput,
    )
  }

  /** Get penalty points based on severity */
  private getPenaltyPoints(severity: string): number {
    const table: Record<string, number> = { low: 2, medium: 5, high: 10, critical: 25 }
    return table[severity] || 5
  }

  /** Get current points state */
  getPointsState(): PointsState {
    return this.pointsSystem.getState()
  }

  /** Get points report */
  getPointsReport(): string {
    return this.pointsSystem.getReport()
  }

  /** Reset for a new generation */
  reset(): void {
    this.repetitionDetector.reset()
    this.hallucinationDetector.reset()
  }
}

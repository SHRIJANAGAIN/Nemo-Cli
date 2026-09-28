/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Points & Penalty System — tracks AI performance, awards points for good work,
 * deducts for mistakes, hallucinations, and repetitions.
 */

export type TaskDifficulty = "easy" | "normal" | "medium" | "high" | "critical"

export interface PointsEntry {
  taskId: string
  taskName: string
  taskDescription: string
  taskType: TaskDifficulty
  timestamp: string
  points: number
  reason: string
  userFeedback?: string
  assistantOutput?: string
}

export interface PenaltyEntry {
  taskId: string
  taskName: string
  taskDescription: string
  taskType: TaskDifficulty
  timestamp: string
  pointsDeducted: number
  reason: string
  userFeedback?: string
  userInput?: string
  assistantOutput?: string
  category: "repetition" | "hallucination" | "error" | "mistake" | "timeout"
}

export interface PointsState {
  totalPoints: number
  entries: PointsEntry[]
  penalties: PenaltyEntry[]
  streak: number
  bestStreak: number
}

const POINTS_TABLE: Record<TaskDifficulty, number> = {
  easy: 5,
  normal: 10,
  medium: 20,
  high: 50,
  critical: 100,
}

const PENALTY_TABLE: Record<TaskDifficulty, number> = {
  easy: 2,
  normal: 5,
  medium: 10,
  high: 25,
  critical: 50,
}

export class PointsSystem {
  private state: PointsState

  constructor() {
    this.state = {
      totalPoints: 0,
      entries: [],
      penalties: [],
      streak: 0,
      bestStreak: 0,
    }
  }

  /**
   * Award points for a completed task.
   */
  award(
    taskId: string,
    taskName: string,
    taskDescription: string,
    taskType: TaskDifficulty,
    reason: string,
    userFeedback?: string,
    assistantOutput?: string,
  ): PointsEntry {
    const basePoints = POINTS_TABLE[taskType]
    // Streak bonus: +10% per streak level, max +50%
    const streakBonus = Math.min(this.state.streak * 0.1, 0.5)
    const points = Math.round(basePoints * (1 + streakBonus))

    const entry: PointsEntry = {
      taskId,
      taskName,
      taskDescription,
      taskType,
      timestamp: new Date().toISOString(),
      points,
      reason,
      userFeedback,
      assistantOutput: assistantOutput?.slice(0, 500),
    }

    this.state.entries.push(entry)
    this.state.totalPoints += points
    this.state.streak++
    if (this.state.streak > this.state.bestStreak) {
      this.state.bestStreak = this.state.streak
    }

    return entry
  }

  /**
   * Deduct points for a mistake, hallucination, or repetition.
   */
  penalize(
    taskId: string,
    taskName: string,
    taskDescription: string,
    taskType: TaskDifficulty,
    reason: string,
    category: PenaltyEntry["category"],
    userFeedback?: string,
    userInput?: string,
    assistantOutput?: string,
  ): PenaltyEntry {
    const basePenalty = PENALTY_TABLE[taskType]
    // Repeated offense: double penalty for same category
    const recentPenalties = this.state.penalties.filter(
      (p) => p.category === category && Date.now() - new Date(p.timestamp).getTime() < 3600_000,
    )
    const multiplier = Math.min(recentPenalties.length + 1, 3)
    const pointsDeducted = basePenalty * multiplier

    const entry: PenaltyEntry = {
      taskId,
      taskName,
      taskDescription,
      taskType,
      timestamp: new Date().toISOString(),
      pointsDeducted,
      reason,
      userFeedback,
      userInput: userInput?.slice(0, 500),
      assistantOutput: assistantOutput?.slice(0, 500),
      category,
    }

    this.state.penalties.push(entry)
    this.state.totalPoints -= pointsDeducted
    this.state.streak = 0 // Reset streak on penalty

    return entry
  }

  /** Get current state */
  getState(): PointsState {
    return { ...this.state }
  }

  /** Get total points */
  getTotalPoints(): number {
    return this.state.totalPoints
  }

  /** Get streak */
  getStreak(): number {
    return this.state.streak
  }

  /** Generate a report */
  getReport(): string {
    const lines: string[] = []
    lines.push(`Total Points: ${this.state.totalPoints}`)
    lines.push(`Current Streak: ${this.state.streak}`)
    lines.push(`Best Streak: ${this.state.bestStreak}`)
    lines.push(`Tasks Completed: ${this.state.entries.length}`)
    lines.push(`Penalties: ${this.state.penalties.length}`)
    if (this.state.penalties.length > 0) {
      lines.push("")
      lines.push("Recent Penalties:")
      for (const p of this.state.penalties.slice(-5)) {
        lines.push(`  -${p.pointsDeducted} [${p.category}] ${p.reason}`)
      }
    }
    return lines.join("\n")
  }
}

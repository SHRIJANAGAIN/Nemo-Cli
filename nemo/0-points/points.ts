/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export type TaskType = "easy" | "normal" | "medium" | "high" | "critical"

export interface PointEntry {
  taskId: string
  taskName: string
  taskDescription: string
  taskType: TaskType
  pointsGiven: number
  timestamp: string
  userFeedback: string
  assistantOutput: string
  availablePoints: number
}

export const POINT_VALUES: Record<TaskType, number> = {
  easy: 1,
  normal: 3,
  medium: 5,
  high: 10,
  critical: 20,
}

export const BONUS = {
  firstTry: 2,
  noErrors: 1,
  positiveFeedback: 3,
}

export const PENALTY = {
  repeatedMistake: -5,
  hallucination: -10,
  userCorrection: -3,
}

function pointsFile(): string {
  return path.join(process.cwd(), "nemo", "0-points", "points.json")
}

export function loadPoints(): PointEntry[] {
  try {
    if (!fs.existsSync(pointsFile())) return []
    return JSON.parse(fs.readFileSync(pointsFile(), "utf8")) as PointEntry[]
  } catch {
    return []
  }
}

export function savePoints(entries: PointEntry[]): void {
  fs.mkdirSync(path.dirname(pointsFile()), { recursive: true })
  fs.writeFileSync(pointsFile(), JSON.stringify(entries, null, 2), "utf8")
}

export function totalPoints(): number {
  return loadPoints().reduce((sum, e) => sum + e.pointsGiven, 0)
}

export function awardPoints(
  taskName: string,
  taskDescription: string,
  taskType: TaskType,
  userFeedback: string,
  assistantOutput: string,
  bonuses: { firstTry?: boolean; noErrors?: boolean; positiveFeedback?: boolean } = {},
): PointEntry {
  let points = POINT_VALUES[taskType]
  if (bonuses.firstTry) points += BONUS.firstTry
  if (bonuses.noErrors) points += BONUS.noErrors
  if (bonuses.positiveFeedback) points += BONUS.positiveFeedback

  const entry: PointEntry = {
    taskId: `task_${Date.now().toString(36)}`,
    taskName,
    taskDescription,
    taskType,
    pointsGiven: points,
    timestamp: new Date().toISOString(),
    userFeedback,
    assistantOutput: assistantOutput.slice(0, 2000),
    availablePoints: totalPoints() + points,
  }

  const all = loadPoints()
  all.push(entry)
  savePoints(all)
  return entry
}

export function getPointsReport(): string {
  const entries = loadPoints()
  const total = totalPoints()
  const byType: Record<string, number> = {}
  for (const e of entries) {
    byType[e.taskType] = (byType[e.taskType] ?? 0) + e.pointsGiven
  }
  return [
    `NEMO POINTS REPORT`,
    `Total Points: ${total}`,
    `Tasks Completed: ${entries.length}`,
    `By Type: ${
      Object.entries(byType)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    `Recent: ${
      entries
        .slice(-3)
        .map((e) => `${e.taskName} (${e.pointsGiven >= 0 ? "+" : ""}${e.pointsGiven})`)
        .join(", ") || "none"
    }`,
  ].join("\n")
}

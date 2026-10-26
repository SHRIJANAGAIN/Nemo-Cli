/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import { loadMistakes } from "./mistake.js"
import { totalPoints } from "../0-points/points.js"

export interface PenaltyEntry {
  id: string
  taskId: string
  taskName: string
  taskDescription: string
  taskType: string
  pointsReduced: number
  timestamp: string
  userFeedback: string
  userInput: string
  assistantOutput: string
  availablePoints: number
}

function penaltyFile(): string {
  return path.join(process.cwd(), "nemo", "1-errors", "penalties.json")
}

export function loadPenalties(): PenaltyEntry[] {
  try {
    if (!fs.existsSync(penaltyFile())) return []
    return JSON.parse(fs.readFileSync(penaltyFile(), "utf8")) as PenaltyEntry[]
  } catch {
    return []
  }
}

export function savePenalties(entries: PenaltyEntry[]): void {
  fs.mkdirSync(path.dirname(penaltyFile()), { recursive: true })
  fs.writeFileSync(penaltyFile(), JSON.stringify(entries, null, 2), "utf8")
}

export function totalPenalties(): number {
  return loadPenalties().reduce((sum, e) => sum + Math.abs(e.pointsReduced), 0)
}

export function applyPenalty(
  taskName: string,
  taskDescription: string,
  taskType: string,
  pointsReduced: number,
  userFeedback: string,
  userInput: string,
  assistantOutput: string,
): PenaltyEntry {
  const entry: PenaltyEntry = {
    id: `pen_${Date.now().toString(36)}`,
    taskId: `task_${Date.now().toString(36)}`,
    taskName,
    taskDescription,
    taskType,
    pointsReduced: Math.abs(pointsReduced),
    timestamp: new Date().toISOString(),
    userFeedback,
    userInput: userInput.slice(0, 1000),
    assistantOutput: assistantOutput.slice(0, 2000),
    availablePoints: totalPointsAfterPenalties(),
  }
  const all = loadPenalties()
  all.push(entry)
  savePenalties(all)
  return entry
}

function totalPointsAfterPenalties(): number {
  const penalties = loadPenalties().reduce((s, e) => s + e.pointsReduced, 0)
  return Math.max(0, totalPoints() - penalties)
}

export function checkSecondMistake(): { isSecond: boolean; mistakeName: string; penalty: number } {
  const mistakes = loadMistakes()
  const counts: Record<string, number> = {}
  for (const m of mistakes) {
    if (!m.isFixed) counts[m.errorName] = (counts[m.errorName] ?? 0) + 1
  }
  for (const [name, count] of Object.entries(counts)) {
    if (count >= 2) return { isSecond: true, mistakeName: name, penalty: count * 5 }
  }
  return { isSecond: false, mistakeName: "", penalty: 0 }
}

export function getPenaltyReport(): string {
  const penalties = loadPenalties()
  const total = totalPenalties()
  return [
    `NEMO PENALTY REPORT`,
    `Total Penalties: ${penalties.length}`,
    `Points Deducted: ${total}`,
    `Second Mistakes: ${penalties.filter((p) => p.pointsReduced >= 10).length}`,
  ].join("\n")
}

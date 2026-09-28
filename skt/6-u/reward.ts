/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import { totalPoints } from "../0-points/points.js"

export interface RewardEntry {
  id: string
  type: "bonus" | "penalty" | "achievement"
  reason: string
  points: number
  timestamp: string
}

const ACHIEVEMENTS = [
  { id: "first_task", name: "First Task Complete", threshold: 1, points: 5 },
  { id: "ten_tasks", name: "10 Tasks Done", threshold: 10, points: 15 },
  { id: "fifty_tasks", name: "50 Tasks Done", threshold: 50, points: 50 },
  { id: "no_errors_5", name: "5 Tasks No Errors", threshold: 5, points: 10 },
  { id: "power_user", name: "Power User (100 tasks)", threshold: 100, points: 100 },
]

function rewardsFile(): string {
  return path.join(process.cwd(), "skt", "6-u", "rewards.json")
}

export function loadRewards(): RewardEntry[] {
  try {
    if (!fs.existsSync(rewardsFile())) return []
    return JSON.parse(fs.readFileSync(rewardsFile(), "utf8")) as RewardEntry[]
  } catch {
    return []
  }
}

export function saveRewards(entries: RewardEntry[]): void {
  fs.mkdirSync(path.dirname(rewardsFile()), { recursive: true })
  fs.writeFileSync(rewardsFile(), JSON.stringify(entries, null, 2), "utf8")
}

export function giveReward(type: "bonus" | "penalty" | "achievement", reason: string, points: number): RewardEntry {
  const entry: RewardEntry = {
    id: `rw_${Date.now().toString(36)}`,
    type,
    reason,
    points,
    timestamp: new Date().toISOString(),
  }
  const all = loadRewards()
  all.push(entry)
  saveRewards(all)
  return entry
}

export function checkAchievements(tasksCompleted: number): RewardEntry[] {
  const rewards: RewardEntry[] = []
  const earned = loadRewards()
    .filter((r) => r.type === "achievement")
    .map((r) => r.reason)

  for (const ach of ACHIEVEMENTS) {
    if (tasksCompleted >= ach.threshold && !earned.includes(ach.name)) {
      rewards.push(giveReward("achievement", ach.name, ach.points))
    }
  }
  return rewards
}

export function getRewardsReport(): string {
  const rewards = loadRewards()
  const totalEarned = rewards.filter((r) => r.points > 0).reduce((s, r) => s + r.points, 0)
  const totalPenalties = rewards.filter((r) => r.points < 0).reduce((s, r) => s + r.points, 0)
  return [
    `TRAYAMBAK REWARDS REPORT`,
    `Total Earned: +${totalEarned}`,
    `Total Penalties: ${totalPenalties}`,
    `Balance: ${totalPoints()}`,
    `Achievements: ${rewards.filter((r) => r.type === "achievement").length}`,
  ].join("\n")
}

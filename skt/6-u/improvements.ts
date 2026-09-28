/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface ImprovementEntry {
  id: string
  description: string
  category: "performance" | "accuracy" | "ux" | "feature" | "bugfix"
  impact: "low" | "medium" | "high"
  beforeState: string
  afterState: string
  verified: boolean
  timestamp: string
}

const improvementsFile = () => path.join(process.cwd(), "skt", "6-u", "improvements.json")

export function loadImprovements(): ImprovementEntry[] {
  try {
    return JSON.parse(fs.readFileSync(improvementsFile(), "utf8")) as ImprovementEntry[]
  } catch {
    return []
  }
}

export function saveImprovements(entries: ImprovementEntry[]): void {
  fs.mkdirSync(path.dirname(improvementsFile()), { recursive: true })
  fs.writeFileSync(improvementsFile(), JSON.stringify(entries, null, 2), "utf8")
}

export function logImprovement(
  description: string,
  category: ImprovementEntry["category"],
  impact: ImprovementEntry["impact"],
  beforeState: string,
  afterState: string,
): ImprovementEntry {
  const entry: ImprovementEntry = {
    id: `imp_${Date.now().toString(36)}`,
    description,
    category,
    impact,
    beforeState: beforeState.slice(0, 500),
    afterState: afterState.slice(0, 500),
    verified: false,
    timestamp: new Date().toISOString(),
  }
  const all = loadImprovements()
  all.push(entry)
  saveImprovements(all)
  return entry
}

export function verifyImprovement(id: string): void {
  const all = loadImprovements()
  const e = all.find((x) => x.id === id)
  if (e) e.verified = true
  saveImprovements(all)
}

export function getImprovementReport(): string {
  const all = loadImprovements()
  const verified = all.filter((e) => e.verified).length
  return [
    `TRAYAMBAK IMPROVEMENT REPORT`,
    `Total Improvements: ${all.length}`,
    `Verified: ${verified} | Pending: ${all.length - verified}`,
    `By Impact: High=${all.filter((e) => e.impact === "high" && e.verified).length}`,
  ].join("\n")
}

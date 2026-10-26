/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { HarnessContext, HarnessPlugin } from "../../../packages/harness/src/index.js"

export interface PersistentGoal {
  objective: string
  createdAt: number
  updatedAt: number
}

export class GoalStore implements HarnessPlugin {
  readonly name = "persistent-goal"
  private readonly file: string
  private goal: PersistentGoal | null = null

  constructor(cwd: string) {
    const dir = path.join(cwd, ".nemo")
    this.file = path.join(dir, "goal.json")
    this.load()
  }

  get(): PersistentGoal | null {
    return this.goal ? { ...this.goal } : null
  }

  set(objective: string): PersistentGoal {
    const value = objective.trim()
    if (!value) throw new Error("Goal cannot be empty.")
    const now = Date.now()
    this.goal = {
      objective: value,
      createdAt: this.goal?.createdAt ?? now,
      updatedAt: now,
    }
    this.save()
    return this.get()!
  }

  clear(): void {
    this.goal = null
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file)
  }

  context(): string {
    return this.goal ? `\nPersistent user goal (keep this in mind while working): ${this.goal.objective}\n` : ""
  }

  setup(context: HarnessContext): void {
    const goal = this.get()
    if (goal) context.setFact("goal", goal.objective)
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PersistentGoal>
    if (typeof raw.objective === "string" && raw.objective.trim()) {
      this.goal = {
        objective: raw.objective.trim(),
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.goal, null, 2), "utf8")
  }
}

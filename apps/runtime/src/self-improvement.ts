/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface ImprovementLesson {
  id: string
  lesson: string
  evidence: string
  verified: boolean
  createdAt: string
  lastUsedAt?: string
}

export class SelfImprovementStore {
  private readonly file: string
  private lessons: ImprovementLesson[] = []

  constructor(cwd: string) {
    this.file = path.join(cwd, ".nemo", "self-improvement.json")
    this.load()
  }

  observe(prompt: string, response: string, hadError: boolean): ImprovementLesson | null {
    const cleanPrompt = prompt.replace(/\s+/g, " ").trim().slice(0, 180)
    const cleanResponse = response.replace(/\s+/g, " ").trim().slice(0, 220)
    if (!cleanPrompt) return null

    const lesson = hadError
      ? `When handling "${cleanPrompt}", inspect the failure before retrying and verify the smallest affected surface.`
      : cleanResponse
        ? `For "${cleanPrompt}", preserve the existing project conventions and verify the result before declaring completion.`
        : null
    if (!lesson || this.lessons.some((entry) => entry.lesson === lesson)) return null

    const entry: ImprovementLesson = {
      id: `lesson_${Date.now().toString(36)}`,
      lesson,
      evidence: cleanResponse || "The exchange completed without a response body.",
      verified: !hadError,
      createdAt: new Date().toISOString(),
    }
    this.lessons.push(entry)
    this.lessons = this.lessons.slice(-50)
    this.save()
    return entry
  }

  refine(): ImprovementLesson[] {
    const recent = this.lessons.slice(-10)
    for (const lesson of recent) {
      lesson.lastUsedAt = new Date().toISOString()
    }
    if (recent.length > 0) this.save()
    return recent.map((lesson) => ({ ...lesson }))
  }

  context(): string {
    const recent = this.lessons.filter((lesson) => lesson.verified).slice(-8)
    if (recent.length === 0) return ""
    return [
      "Self-improvement lessons from verified prior work:",
      ...recent.map((lesson) => `  - ${lesson.lesson}`),
    ].join("\n")
  }

  list(): ImprovementLesson[] {
    return this.lessons.map((lesson) => ({ ...lesson }))
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown
    if (Array.isArray(parsed)) {
      this.lessons = parsed.filter(
        (entry): entry is ImprovementLesson =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ImprovementLesson).lesson === "string" &&
          typeof (entry as ImprovementLesson).evidence === "string",
      )
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.lessons, null, 2), "utf8")
  }
}

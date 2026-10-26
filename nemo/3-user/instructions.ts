/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface UserInstruction {
  id: string
  title: string
  content: string
  category: "coding" | "style" | "workflow" | "preference" | "constraint"
  priority: number // 1 = highest
  active: boolean
  createdAt: string
}

function instructionsFile(): string {
  return path.join(process.cwd(), "nemo", "3-user", "instructions.json")
}

export function loadInstructions(): UserInstruction[] {
  try {
    if (!fs.existsSync(instructionsFile())) return getDefaultInstructions()
    return JSON.parse(fs.readFileSync(instructionsFile(), "utf8")) as UserInstruction[]
  } catch {
    return getDefaultInstructions()
  }
}

export function saveInstructions(instructions: UserInstruction[]): void {
  fs.mkdirSync(path.dirname(instructionsFile()), { recursive: true })
  fs.writeFileSync(instructionsFile(), JSON.stringify(instructions, null, 2), "utf8")
}

export function addInstruction(
  title: string,
  content: string,
  category: UserInstruction["category"] = "preference",
  priority = 5,
): UserInstruction {
  const instruction: UserInstruction = {
    id: `inst_${Date.now().toString(36)}`,
    title,
    content,
    category,
    priority,
    active: true,
    createdAt: new Date().toISOString(),
  }
  const all = loadInstructions()
  all.push(instruction)
  saveInstructions(all)
  return instruction
}

export function getActiveInstructions(): UserInstruction[] {
  return loadInstructions()
    .filter((i) => i.active)
    .sort((a, b) => a.priority - b.priority)
}

export function getInstructionsContextBlock(): string {
  const active = getActiveInstructions()
  if (active.length === 0) return ""
  const lines = active.map((i) => `  - [${i.category}] ${i.title}: ${i.content.slice(0, 120)}`)
  return ["## User Instructions:", ...lines].join("\n")
}

function getDefaultInstructions(): UserInstruction[] {
  return [
    {
      id: "default_1",
      title: "Code Quality",
      content: "Write clean, well-commented code. Prefer simplicity over cleverness.",
      category: "coding",
      priority: 1,
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: "default_2",
      title: "File Safety",
      content: "Always read a file before editing it. Confirm structure before large rewrites.",
      category: "constraint",
      priority: 1,
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: "default_3",
      title: "No Hallucination",
      content: "Never invent or guess tool results. Only state facts from real tool outputs.",
      category: "constraint",
      priority: 1,
      active: true,
      createdAt: new Date().toISOString(),
    },
  ]
}

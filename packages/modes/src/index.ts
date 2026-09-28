/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** Custom modes (.roomodes) — built-ins + project file override. */

import * as fs from "fs"
import * as path from "path"

export interface Roomode {
  slug: string
  name: string
  roleDefinition: string
  groups: Array<"read" | "edit" | "command" | "mcp" | "modes">
}

export const DEFAULT_MODES: Roomode[] = [
  {
    slug: "code",
    name: "Code",
    roleDefinition: "Implement features and fix bugs.",
    groups: ["read", "edit", "command", "mcp"],
  },
  {
    slug: "architect",
    name: "Architect",
    roleDefinition: "Plan high-level architecture.",
    groups: ["read", "mcp", "modes"],
  },
  { slug: "ask", name: "Ask", roleDefinition: "Answer questions about the codebase.", groups: ["read", "mcp"] },
  {
    slug: "debug",
    name: "Debug",
    roleDefinition: "Diagnose failures systematically.",
    groups: ["read", "edit", "command", "mcp"],
  },
  {
    slug: "orchestrator",
    name: "Orchestrator",
    roleDefinition: "Break down tasks and delegate.",
    groups: ["read", "modes", "mcp"],
  },
]

export function getModeBySlug(slug: string, custom: Roomode[] = []): Roomode | undefined {
  return [...custom, ...DEFAULT_MODES].find((m) => m.slug === slug)
}

export function loadRoomodes(cwd: string = process.cwd()): Roomode[] {
  try {
    const file = path.join(cwd, ".roomodes")
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { customModes?: Roomode[] }
    if (!Array.isArray(raw.customModes)) return []
    return raw.customModes.filter((m) => typeof m?.slug === "string" && Array.isArray(m.groups)).slice(0, 50)
  } catch {
    return []
  }
}

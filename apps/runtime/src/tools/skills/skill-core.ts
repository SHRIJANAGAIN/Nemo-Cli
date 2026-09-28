/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export function defaultSkillsDir(): string {
  const projectSkills = path.join(process.cwd(), "skills")
  if (fs.existsSync(projectSkills)) return projectSkills
  const local = path.join(process.cwd(), ".trayambak", "skills")
  if (fs.existsSync(local)) return local
  return path.join(os.homedir(), ".trayambak", "skills")
}

export function walkSkillFiles(dir: string): string[] {
  const out: string[] = []
  function walk(current: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile()) {
        const isSkillFile = e.name === "SKILL.md" || e.name.endsWith(".md")
        if (isSkillFile) out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

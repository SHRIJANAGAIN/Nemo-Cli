/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export type SkillState = "active" | "stale" | "archived"

export interface SkillUsage {
  name: string
  useCount: number
  viewCount: number
  patchCount: number
  lastActivityAt: string
  state: SkillState
  pinned: boolean
}

export interface LibrarianConfig {
  skillsDir: string
  usageFile: string
  staleAfterDays: number
  archiveAfterDays: number
  intervalHours: number
}

export class Librarian {
  private readonly config: LibrarianConfig
  private usage: Map<string, SkillUsage>

  constructor(config: LibrarianConfig) {
    this.config = config
    this.usage = new Map()
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.config.usageFile)) return
    try {
      const raw = fs.readFileSync(this.config.usageFile, "utf8")
      const data = JSON.parse(raw) as SkillUsage[]
      this.usage = new Map(data.map((u) => [u.name, u]))
    } catch {
      this.usage = new Map()
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.config.usageFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.config.usageFile, JSON.stringify(Array.from(this.usage.values()), null, 2))
  }

  recordUsage(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    existing.useCount += 1
    existing.lastActivityAt = new Date().toISOString()
    if (existing.state === "stale") existing.state = "active"
    this.usage.set(name, existing)
  }

  recordView(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    existing.viewCount += 1
    existing.lastActivityAt = new Date().toISOString()
    this.usage.set(name, existing)
  }

  pin(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    existing.pinned = true
    this.usage.set(name, existing)
  }

  unpin(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    existing.pinned = false
    this.usage.set(name, existing)
  }

  stale(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    if (!existing.pinned) existing.state = "stale"
    this.usage.set(name, existing)
  }

  archive(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    if (!existing.pinned) existing.state = "archived"
    this.usage.set(name, existing)
  }

  restore(name: string): void {
    const existing = this.usage.get(name) ?? this.create(name)
    existing.state = "active"
    this.usage.set(name, existing)
  }

  get(name: string): SkillUsage | undefined {
    return this.usage.get(name)
  }

  list(): SkillUsage[] {
    return Array.from(this.usage.values())
  }

  private create(name: string): SkillUsage {
    return {
      name,
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      lastActivityAt: new Date().toISOString(),
      state: "active",
      pinned: false,
    }
  }
}

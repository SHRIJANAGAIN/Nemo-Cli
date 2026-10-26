/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { SkillMetadata } from "./skill-model.js"

export interface ExplicitSkillLookup {
  skills(): SkillMetadata[]
  disabledPaths(): Set<string>
  skillDiscoveryPathForPath(path: string): string | undefined
  isSkillEnabled(skill: SkillMetadata): boolean
}

export interface SelectionContext {
  loadedSkills: ExplicitSkillLookup
  seenNames: Set<string>
  seenPaths: Set<string>
}

export function collectExplicitSkillMentions(
  inputs: Array<{ type: string; text?: string; name?: string; path?: string }>,
  context: SelectionContext,
  connectorSlugCounts: Record<string, number>,
): SkillMetadata[] {
  const selected: SkillMetadata[] = []
  const seenNames = new Set(context.seenNames)
  const seenPaths = new Set(context.seenPaths)

  for (const input of inputs) {
    if (input.type === "skill" && input.path) {
      const skill = context.loadedSkills.skills().find((s) => s.pathToSkillsMd === input.path)
      if (skill && context.loadedSkills.isSkillEnabled(skill) && !seenPaths.has(skill.pathToSkillsMd)) {
        seenPaths.add(skill.pathToSkillsMd)
        seenNames.add(skill.name)
        selected.push(skill)
      }
    }
  }

  for (const input of inputs) {
    if (input.type === "text" && input.text) {
      const mentions = extractPlainSkillMentions(input.text)
      selectSkillsFromMentions(mentions, context, connectorSlugCounts, selected, seenNames, seenPaths)
    }
  }

  context.seenNames = seenNames
  context.seenPaths = seenPaths
  return selected
}

export function selectSkillsFromMentions(
  mentions: string[],
  context: SelectionContext,
  connectorSlugCounts: Record<string, number>,
  selected: SkillMetadata[],
  seenNames: Set<string>,
  seenPaths: Set<string>,
): void {
  if (mentions.length === 0) return

  const mentionPaths = new Set<string>()
  for (const mention of mentions) {
    const normalized = normalizeSkillPath(mention)
    if (normalized) mentionPaths.add(normalized)
  }

  for (const skill of context.loadedSkills.skills()) {
    if (!context.loadedSkills.isSkillEnabled(skill) || seenPaths.has(skill.pathToSkillsMd)) {
      continue
    }
    const canonical = normalizeSkillPath(skill.pathToSkillsMd)
    const discoveryPath = context.loadedSkills.skillDiscoveryPathForPath(skill.pathToSkillsMd)
    const matchesDiscovery = discoveryPath ? mentionPaths.has(normalizeSkillPath(discoveryPath)) : false
    if (canonical && mentionPaths.has(canonical)) {
      seenPaths.add(skill.pathToSkillsMd)
      seenNames.add(skill.name)
      selected.push(skill)
    } else if (matchesDiscovery) {
      seenPaths.add(skill.pathToSkillsMd)
      seenNames.add(skill.name)
      selected.push(skill)
    }
  }

  for (const skill of context.loadedSkills.skills()) {
    if (!context.loadedSkills.isSkillEnabled(skill) || seenPaths.has(skill.pathToSkillsMd)) {
      continue
    }
    const plainMatch = mentions.some((m) => m.toLowerCase() === skill.name.toLowerCase())
    if (!plainMatch) continue
    const skillCount = context.loadedSkills.skills().filter((s) => s.name === skill.name).length || 0
    const connectorCount = connectorSlugCounts[skill.name.toLowerCase()] || 0
    if (skillCount !== 1 || connectorCount !== 0) continue
    seenPaths.add(skill.pathToSkillsMd)
    seenNames.add(skill.name)
    selected.push(skill)
  }
}

function extractPlainSkillMentions(text: string): string[] {
  const mentions: string[] = []
  const re = /(?:^|\s)([\w-]+(?:\/[\w-]+)*)\s*(?:::|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    mentions.push(m[1])
  }
  return mentions
}

export function normalizeSkillPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase()
}

export function buildSkillMentionsBlock(skills: SkillMetadata[]): string {
  if (!skills || skills.length === 0) return ""
  const lines = skills.map((s) => `- ${s.name}: ${s.shortDescription ?? s.description}`)
  return ["Explicitly mentioned skills:", ...lines].join("\n")
}

export function skillMentionNames(skills: SkillMetadata[]): string[] {
  return skills.map((s) => s.name)
}

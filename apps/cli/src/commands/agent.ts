/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { discoverAgentProfiles, type AgentProfile } from "../../../runtime/src/agent/specialist-agents.js"

export interface AgentOptions {
  readonly action: "list" | "info" | "run"
  readonly type?: string
  readonly prompt?: string
  readonly description?: string
}

export interface AgentProfileSummary {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
}

export function listAgentProfiles(): AgentProfileSummary[] {
  const profiles = discoverAgentProfiles(process.cwd())
  return profiles.map((p) => ({
    id: p.file,
    name: p.name,
    category: p.category,
    description: p.description,
  }))
}

export function findProfile(type: string): AgentProfileSummary | undefined {
  const profiles = discoverAgentProfiles(process.cwd())
  return profiles
    .map((p) => ({
      id: p.file,
      name: p.name,
      category: p.category,
      description: p.description,
    }))
    .find((p) => p.id === type || p.name.toLowerCase() === type.toLowerCase())
}

export function agentCommand(options: AgentOptions): string {
  switch (options.action) {
    case "list": {
      const profiles = listAgentProfiles()
      if (profiles.length === 0) return "No agent profiles available"
      return profiles.map((p) => `- ${p.id} [${p.category}] ${p.name}: ${p.description}`).join("\n")
    }
    case "info": {
      if (!options.type) return "Missing agent type"
      const profile = findProfile(options.type)
      if (!profile) return `Agent profile not found: ${options.type}`
      return `Agent: ${profile.id}\nName: ${profile.name}\nCategory: ${profile.category}\nDescription: ${profile.description}`
    }
    case "run": {
      if (!options.type || !options.prompt) return "Missing type or prompt"
      const profile = findProfile(options.type)
      if (!profile) return `Agent profile not found: ${options.type}`
      return `[Agent queued] ${profile.name} will execute: ${options.prompt.slice(0, 200)}${options.prompt.length > 200 ? "..." : ""}`
    }
    default:
      return `Unknown agent action: ${options.action}`
  }
}

export function getAgentProfilesRaw(): AgentProfile[] {
  return discoverAgentProfiles(process.cwd())
}

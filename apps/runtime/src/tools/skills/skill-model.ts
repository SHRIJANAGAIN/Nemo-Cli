/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export interface SkillPolicy {
  allowImplicitInvocation?: boolean
  products: string[]
}

export interface SkillInterface {
  displayName?: string
  shortDescription?: string
  iconSmall?: string
  iconLarge?: string
  brandColor?: string
  defaultPrompt?: string
}

export interface SkillToolDependency {
  type: string
  value: string
  description?: string
  transport?: string
  command?: string
  url?: string
  oauthCallbackPort?: number
}

export interface SkillDependencies {
  tools: SkillToolDependency[]
}

export interface SkillMetadata {
  name: string
  description: string
  shortDescription?: string
  model?: string
  interface?: SkillInterface
  dependencies?: SkillDependencies
  policy?: SkillPolicy
  pathToSkillsMd: string
  scope: "local" | "project" | "system"
  pluginId?: string
}

export interface LoadedSkillRoot {
  root: string
  skills: SkillMetadata[]
  errors: Array<{ path: string; message: string }>
}

export interface LoadedSkills {
  skills: SkillMetadata[]
  errors: Array<{ path: string; message: string }>
}

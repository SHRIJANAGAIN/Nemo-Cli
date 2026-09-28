/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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

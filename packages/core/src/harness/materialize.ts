/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Materialising a harness: turning the tree into what the agent actually sees.
 *
 * The injection order is fixed and deliberate:
 *
 *   always-on body -> skills index -> subagents index -> scripts -> plugins
 *
 * The task comes LAST, so the harness shapes the work rather than competing
 * with it. A component that is not named in the always-on body never fires,
 * so the indexes name every component and validation refuses an orphan.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import type { HarnessTree } from "./types.js"
import {
  NEMO_SURFACE,
  alwaysOnText,
  frontmatterValue,
  skillNames,
  subagentNames,
  type SurfaceSpec,
} from "./tree.js"

/** The rendered harness, ready to be spliced into a system prompt. */
export interface RenderedHarness {
  /** The always-on body (system prompt, guardrails, tool guidance, memory). */
  alwaysOn: string
  /** The one-line index of the skills, when there are any. */
  skillsIndex: string
  /** The one-line index of the subagents, when there are any. */
  subagentsIndex: string
  /** The listing of the helper scripts, when there are any. */
  scriptsListing: string
  /** The listing of the plugins, when there are any. */
  pluginsListing: string
  /** Everything the agent should be told, in injection order. */
  block: string
}

/** Render a harness tree into agent-facing context. */
export function renderHarness(
  tree: HarnessTree,
  surface: SurfaceSpec = NEMO_SURFACE,
): RenderedHarness {
  const alwaysOn = alwaysOnText(surface, tree).trim()
  const skills = skillNames(surface, tree).map((name) => ({
    name,
    body: tree[`${surface.skillDir}/${name}/SKILL.md`] ?? "",
  }))
  const subagents = subagentNames(surface, tree).map((name) => ({
    name,
    body: tree[`${surface.subagentDir}/${name}/AGENT.md`] ?? "",
  }))
  const scripts = Object.keys(tree)
    .filter((rel) => rel.startsWith(`${surface.scriptDir}/`) && rel.endsWith(".mjs"))
    .sort()
  const plugins =
    surface.pluginDir === null
      ? []
      : Object.keys(tree)
          .filter(
            (rel) => rel.startsWith(`${surface.pluginDir}/`) && rel.endsWith(".mjs"),
          )
          .sort()

  const skillsIndex =
    skills.length > 0
      ? [
          "# AVAILABLE SKILLS",
          "Load a skill with the `skill` tool when the situation matches:",
          ...skills.map((skill) => `- \`${skill.name}\`: ${describeBody(skill.body)}`),
        ].join("\n")
      : ""

  const subagentsIndex =
    subagents.length > 0
      ? [
          "# AVAILABLE SUBAGENTS",
          "Delegate with the `task` tool when the situation matches:",
          ...subagents.map((agent) => `- \`${agent.name}\`: ${describeBody(agent.body)}`),
        ].join("\n")
      : ""

  const scriptsListing =
    scripts.length > 0
      ? [
          "# HELPER SCRIPTS",
          `Deterministic helpers are available in \`${surface.scriptDir}/\`:`,
          ...scripts.map((rel) => `- \`node ${rel}\` — ${describeBody(tree[rel] ?? "")}`),
          "Prefer a helper over re-deriving the same logic by hand.",
        ].join("\n")
      : ""

  const pluginsListing =
    plugins.length > 0
      ? [
          "# PLUGINS",
          "Middleware that wraps the tool loop:",
          ...plugins.map((rel) => `- \`${rel}\` — ${describeBody(tree[rel] ?? "")}`),
        ].join("\n")
      : ""

  const block = [alwaysOn, skillsIndex, subagentsIndex, scriptsListing, pluginsListing]
    .filter((part) => part.length > 0)
    .join("\n\n---\n\n")

  return { alwaysOn, skillsIndex, subagentsIndex, scriptsListing, pluginsListing, block }
}

/** The description of a component: frontmatter first, then its first meaningful line. */
export function describeBody(body: string): string {
  const description = frontmatterValue(body, "description")
  if (description && description.length > 0) return description
  const heading = /^#\s+(.+)$/m.exec(body)
  if (heading) return heading[1]!.trim()
  const line = body
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.length > 0 && !row.startsWith("---") && !row.startsWith("#"))
  return line ?? "no description"
}

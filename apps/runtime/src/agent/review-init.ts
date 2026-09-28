/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Prompt builders for the /review and /init slash commands (opencode
 *  init/review port). Pure string functions — the TUI submits the result
 *  as a normal turn via handleInput, so the agent does the work with its
 *  full toolset (bash for git, readers for files, trayambak__ParallelReview
 *  for the multi-dimension pass). No new agent plumbing needed. */

export type ReviewTarget = { kind: "working-tree" } | { kind: "commit"; ref: string } | { kind: "branch"; ref: string }

/** Parse /review arguments: bare → working tree, `commit <sha>` →
 *  git show, `branch <name>` → diff against that branch. */
export function parseReviewArgs(args: string): ReviewTarget {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2 && parts[0]?.toLowerCase() === "commit" && parts[1]) {
    return { kind: "commit", ref: parts[1].slice(0, 64) }
  }
  if (parts.length >= 2 && parts[0]?.toLowerCase() === "branch" && parts[1]) {
    return { kind: "branch", ref: parts[1].slice(0, 64) }
  }
  return { kind: "working-tree" }
}

export function buildReviewPrompt(args: string): string {
  const target = parseReviewArgs(args)
  const diffStep =
    target.kind === "commit"
      ? `git show --stat ${target.ref} and git show ${target.ref} for the full diff`
      : target.kind === "branch"
        ? `git diff --stat ${target.ref}...HEAD and git diff ${target.ref}...HEAD for the full diff`
        : `git status --short plus git diff (unstaged) and git diff --cached (staged) for the full diff`
  const scope =
    target.kind === "commit"
      ? `commit ${target.ref}`
      : target.kind === "branch"
        ? `branch changes vs ${target.ref}`
        : `uncommitted working-tree changes (staged + unstaged)`
  return [
    `Review ${scope} like a principal engineer. Steps:`,
    `1. Collect the change set with ${diffStep}.`,
    `2. Read the FULL changed files (not just diff hunks) plus AGENTS.md/CONTEXT.md conventions if present.`,
    `3. Run trayambak__ParallelReview on the unified diff, then deduplicate findings across correctness, language-specific pitfalls, and security dimensions.`,
    `4. Adversarially verify every critical/high finding against the actual code before reporting (no speculative findings).`,
    `5. Report: file:line verdicts grouped by severity, each with the exact fix. If the tree is clean, say so in one line.`,
  ].join("\n")
}

export function buildInitPrompt(): string {
  return [
    `Initialize this project's agent rules. Steps:`,
    `1. Scan the repo: README*, manifests/lockfiles (package.json, pyproject.toml, go.mod, Cargo.toml), build/test/lint/typecheck scripts, CI configs, and any existing AGENTS.md / CLAUDE.md / CONTEXT.md / .cursor/rules / copilot instructions.`,
    `2. Write or update AGENTS.md in the project root: build/test/lint commands, code style, repo layout, gotchas. Keep it under 60 lines — durable rules only, no transient state.`,
    `3. If you learned durable user/project facts (toolchain, preferences), store them with the memory tool.`,
    `4. Reply with a 5-line summary of what you recorded. Do not start unrelated work.`,
  ].join("\n")
}

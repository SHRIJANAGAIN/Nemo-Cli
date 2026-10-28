/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * End-of-session harness improvement — the autonomous half.
 *
 * The recursion itself lives in `packages/core/src/harness` and is driven by
 * `harnessCommand`. Until now it only ran when the user typed `/harness
 * run <task>`, so the agent never improved on its own. This module removes
 * that command from the loop: when an interactive session ends, the last
 * real request is turned into a harness task, written to
 * `~/.nemo/harness/pending/`, and handed to a detached
 * `harness auto <task-file>` child.
 *
 * Detached on purpose: the TUI's exit path calls `process.exit`, so an
 * in-process run would be killed mid-flight. The child inherits the
 * environment (provider, key, config) and outlives the terminal it was
 * started from.
 *
 * Nothing here throws or blocks. A missing CLI entry, an unwritable home or
 * a spawn failure all mean "no improvement this time", never "the exit
 * failed".
 */

import { spawn } from "child_process"
import * as fs from "fs"
import { homedir } from "os"
import * as path from "path"

/** The minimum shape of a transcript row this module reads. */
export interface SessionMessage {
  role: string
  content?: string
  toolName?: string
}

/** One autonomous improvement job, as written to the pending directory. */
export interface SessionTask {
  request: string
  sourceDir: string
  domain: string
  notes: string
  k: number
  mode: "parallel" | "sequential"
}

export interface SessionImproveInput {
  cwd: string
  messages: ReadonlyArray<SessionMessage>
  /** `harnessAuto: false` (config or env) turns the trigger off. */
  config?: { harnessAuto?: boolean }
  home?: string
  env?: NodeJS.ProcessEnv
}

/** A request shorter than this is not a task worth re-running. */
const MIN_REQUEST_CHARS = 24

/** How much of the last request is kept. */
const MAX_REQUEST_CHARS = 2_000

/** How much of the last assistant report is kept as notes. */
const MAX_NOTES_CHARS = 600

/** Env kill switch, matching the auto-update naming. */
export const HARNESS_AUTO_KILL_SWITCH = "NEMO_DISABLE_HARNESS_AUTO"

/** Set on the child, so an improvement run can never start another one. */
export const HARNESS_CHILD_ENV = "NEMO_HARNESS_CHILD"

function truthy(raw: string | undefined): boolean {
  if (raw === undefined) return false
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** `~/.nemo/harness/pending`. */
export function pendingTaskDir(home: string = homedir()): string {
  return path.join(home, ".nemo", "harness", "pending")
}

/**
 * The harness task a finished session implies, or null.
 *
 * A session only earns a run when it did real work: a substantive, non-slash
 * user request AND at least one tool call. Chit-chat and `/commands` have no
 * trajectory to learn from, and re-running them would only burn budget.
 */
export function buildSessionTask(input: SessionImproveInput): SessionTask | null {
  const messages = input.messages
  const requests = messages
    .filter((message) => message.role === "user")
    .map((message) => (message.content ?? "").trim())
    .filter((content) => content.length >= MIN_REQUEST_CHARS && !content.startsWith("/"))
  const request = requests.at(-1)
  if (!request) return null

  const usedTools = messages.some((message) => typeof message.toolName === "string" && message.toolName.length > 0)
  if (!usedTools) return null

  const lastReport = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.toolName &&
        (message.content ?? "").trim().length > 0,
    )
  const notes = lastReport
    ? `The session ended after this report:\n${(lastReport.content ?? "").trim().slice(0, MAX_NOTES_CHARS)}`
    : ""

  return {
    request: request.slice(0, MAX_REQUEST_CHARS),
    sourceDir: input.cwd,
    domain: domainFor(input.cwd),
    notes,
    k: 1,
    mode: "parallel",
  }
}

/** A stable library area for a workspace: its directory name, slugged. */
export function domainFor(cwd: string): string {
  const base = path.basename(path.resolve(cwd)).toLowerCase()
  const slug = base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return slug.length > 0 ? slug : "default"
}

/**
 * The compiled CLI entry, or null when this is a source checkout that was
 * never built. `dist/apps/runtime/src/agent/` → `dist/apps/cli/src/index.js`.
 */
export function resolveCliEntry(): string | null {
  const override = process.env.NEMO_HARNESS_ENTRY
  if (override && fs.existsSync(override)) return override
  const entry = path.join(__dirname, "../../../cli/src/index.js")
  return fs.existsSync(entry) ? entry : null
}

/**
 * Schedule one improvement run for a finished session.
 *
 * Returns the pending task file it wrote, or null when nothing was
 * scheduled. Safe to call from an exit handler: it is synchronous up to the
 * spawn and never throws.
 */
export function scheduleSessionImprovement(input: SessionImproveInput): string | null {
  const env = input.env ?? process.env
  try {
    if (truthy(env[HARNESS_CHILD_ENV])) return null
    if (truthy(env[HARNESS_AUTO_KILL_SWITCH])) return null
    if (input.config?.harnessAuto === false) return null

    const task = buildSessionTask(input)
    if (!task) return null

    const entry = resolveCliEntry()
    if (!entry) return null

    const home = input.home ?? homedir()
    const dir = pendingTaskDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now().toString(36)}-${process.pid.toString(36)}.json`)
    fs.writeFileSync(file, JSON.stringify(task, null, 2), "utf8")

    const childEnv: NodeJS.ProcessEnv = { ...env, [HARNESS_CHILD_ENV]: "1" }
    // The TUI child carries these; stripping them keeps the improvement
    // process from re-entering the interactive path.
    delete childEnv.NEMO_PROMPT
    delete childEnv.NEMO_CONFIG_JSON

    const child = spawn(process.execPath, [entry, "harness", "auto", file], {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv,
    })
    child.unref()
    return file
  } catch {
    return null
  }
}

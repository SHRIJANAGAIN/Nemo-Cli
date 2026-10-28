/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The Nemo ports for the recursive harness.
 *
 * The engine in packages/core/src/harness is model-agnostic; this module
 * is where a Nemo agent becomes the model behind it:
 *
 * - ROLLOUT: a task runs in a copy of its source tree with a candidate
 *   harness rendered into the system prompt; the trajectory and the files
 *   the run produced are the evidence.
 * - SESSION: an improver gets an isolated workspace whose `context/`
 *   directory holds the evidence and whose `context/harness/` it edits.
 *   The edited tree comes back through the harvest, never through prose.
 *
 * Every model call gets its own agent, its own session and its own working
 * directory, so a stage can never see another stage's edits.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { homedir } from "os"
import { Agent } from "./agent.js"
import type { AgentEvent } from "../../../../packages/protocol/src/index.js"
import type { NemoConfig } from "../config.js"
import {
  NEMO_SURFACE,
  copyTree,
  readTree,
  renderHarness,
  walk,
  type HarnessRolloutRequest,
  type HarnessRun,
  type HarnessSessionRequest,
  type HarnessSessionResult,
  type RolloutPort,
  type RuntimePorts,
  type SessionPort,
} from "../../../../packages/core/src/harness/index.js"

/** How much of one observation is kept in a trajectory. */
const OBS_TRUNC = 4000

/** How much of one tool's arguments is kept. */
const ARGS_TRUNC = 400

/** The most files one rollout may report as its deliverable. */
const MAX_DELIVERABLE_FILES = 24

/** The largest file body one rollout may report, in bytes. */
const MAX_DELIVERABLE_BYTES = 200_000

/** Directories that are never part of a deliverable. */
const SKIP_DIRS = new Set([".git", "node_modules", ".scratchpad", ".harness", "dist", "build"])

/**
 * Directories a task's source copy skips.
 *
 * A rollout re-runs the task in a copy of the repository, not a backup of
 * it: build output, caches, checkpoints and virtualenvs only slow the copy
 * down and would be regenerated anyway.
 */
const SOURCE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".scratchpad",
  ".nemo",
  ".harness",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
])

/** Cap on one task's source copy: enough for a real repo, never a mirror. */
const SOURCE_MAX_FILES = 4_000
const SOURCE_MAX_BYTES = 64 * 1024 * 1024

/** Options for the Nemo ports. */
export interface HarnessPortOptions {
  config: NemoConfig
  /** Where the harness trees are materialised. Defaults to a temp dir. */
  workDir?: string
  /** The harness that "no candidate" means. Defaults to the active harness. */
  baseHarnessDir?: string
}

/** The ports, bound to a real Nemo agent. */
export interface NemoHarnessPorts extends RuntimePorts {
  /** The directory harness workspaces live in. */
  readonly workDir: string
  /** The harness rendered for a base rollout. */
  readonly baseHarnessDir: string
}

/** Render the trajectory of one rollout in the method's grammar. */
export function renderTrajectory(events: AgentEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === "message_update" || event.type === "message_start") {
      const text = "delta" in event ? event.delta.text : undefined
      if (text) lines.push(`[ASSISTANT] ${text}`)
      continue
    }
    if (event.type === "thinking") {
      lines.push(`[THINKING] ${event.thinking}`)
      continue
    }
    if (event.type === "tool_execution_start") {
      const args = JSON.stringify(event.args ?? {}).slice(0, ARGS_TRUNC)
      lines.push(`[ACTION] ${event.toolName}(${args})`)
      continue
    }
    if (event.type === "tool_execution_end") {
      const text = toolResultText(event.result).slice(0, OBS_TRUNC)
      const tag = event.isError ? "OBSERVATION ERROR" : "OBSERVATION"
      lines.push(`[${tag}] ${text}`)
      continue
    }
    if (event.type === "permission_request") {
      lines.push(`[PERMISSION] ${event.tool} — ${event.reason}`)
      continue
    }
  }
  return lines.join("\n")
}

function toolResultText(result: { content?: Array<{ type: string; text: string }> }): string {
  if (!result || !Array.isArray(result.content)) return ""
  return result.content.map((part) => part.text ?? "").join("\n")
}

/** File tools an isolated harness workspace may use without a human. */
const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "next_edit",
  "list_dir",
  "glob",
  "grep",
  "code_search",
  "semantic_search",
  "symbol_search",
  "patch",
  "diff",
  "read_manifest",
])

/** Arguments that can name a location a tool will touch. */
const PATH_ARGS = ["path", "file_path", "cwd"] as const

/** Arguments that can escape a directory through a glob. */
const GLOB_ARGS = ["pattern", "glob"] as const

/**
 * The narrowest approval that still lets a harness run work.
 *
 * A harness run is autonomous, so there is nobody to answer an approval
 * prompt. It must not become blanket approval either: the repository's own
 * rules forbid a mode where everything is allowed. The middle ground is
 * spatial — a harness stage may read and write inside its own isolated
 * workspace, and nothing else. `bash`, the network, MCP servers and
 * subagents stay gated, so a user's existing permission config still
 * decides whether those are reachable; the harness never widens it.
 */
export function scopedApproval(workspace: string): (tool: string, args: unknown) => Promise<boolean> {
  return async (tool: string, args: unknown): Promise<boolean> => {
    if (!WORKSPACE_TOOLS.has(tool)) return false
    const root = path.resolve(workspace)
    const input =
      typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {}
    for (const key of PATH_ARGS) {
      const value = input[key]
      if (typeof value !== "string" || value.length === 0) continue
      const target = path.resolve(root, value)
      const rel = path.relative(root, target)
      if (rel.startsWith("..") || path.isAbsolute(rel)) return false
    }
    for (const key of GLOB_ARGS) {
      const value = input[key]
      if (typeof value !== "string") continue
      if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return false
    }
    return true
  }
}

/** The last assistant message of a rollout: its report to the user. */
export function extractDeliverable(events: AgentEvent[]): string {
  let text = ""
  for (const event of events) {
    if (event.type === "message_update") {
      if (event.delta.text) text += event.delta.text
      continue
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const content = event.message.content
      const parts = Array.isArray(content) ? content : []
      for (const part of parts) {
        if (part.type === "text") text = part.text
      }
    }
  }
  return text.trim()
}

/** Read the text files a rollout left behind, as the artifact a selector can judge. */
export function snapshotFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0
  for (const file of walk(root)) {
    if (count >= MAX_DELIVERABLE_FILES) break
    const rel = path.relative(root, file).replace(/\\/g, "/")
    if (rel.split("/").some((part) => SKIP_DIRS.has(part))) continue
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    if (size > MAX_DELIVERABLE_BYTES) continue
    let body: string
    try {
      body = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    if (body.includes("\u0000")) continue
    out[rel] = body
    count++
  }
  return out
}

/**
 * Build the ports.
 *
 * A session's workspace is the directory the engine prepared: `context/`
 * is already inside it, and the engine harvests `context/harness` after
 * the run. The session never sees the engine's own bookkeeping.
 */
export function createNemoHarnessPorts(options: HarnessPortOptions): NemoHarnessPorts {
  const workDir = options.workDir ?? path.join(os.tmpdir(), "nemo-harness")
  fs.mkdirSync(workDir, { recursive: true })
  const baseHarnessDir = options.baseHarnessDir ?? path.join(homedir(), ".nemo", "harness")

  const call = async (
    cwd: string,
    prompt: string,
    harnessBlock: string,
  ): Promise<AgentEvent[]> => {
    const config: NemoConfig = {
      ...options.config,
      cwd,
      scratchpadDir: path.join(cwd, ".scratchpad"),
    }
    const agent = new Agent({
      config,
      ...(harnessBlock ? { harnessBlock } : {}),
      onRequestPermission: scopedApproval(cwd),
    })
    const events: AgentEvent[] = []
    await agent.run(prompt, (event) => {
      events.push(event)
    })
    return events
  }

  const rollout: RolloutPort = {
    async run(request: HarnessRolloutRequest): Promise<HarnessRun> {
      const started = Date.now()
      const runDir = request.runDir
      fs.mkdirSync(runDir, { recursive: true })
      if (request.task.sourceDir) {
        copyTree(request.task.sourceDir, runDir, {
          skipDirs: SOURCE_SKIP_DIRS,
          maxFiles: SOURCE_MAX_FILES,
          maxBytes: SOURCE_MAX_BYTES,
        })
      }
      const harnessDir = request.harnessDir ?? baseHarnessDir
      let block = ""
      if (fs.existsSync(harnessDir)) {
        block = renderHarness(readTree(NEMO_SURFACE, harnessDir)).block
      }
      const prompt = [request.task.request, request.task.notes ?? ""]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      try {
        const events = await call(runDir, prompt, block)
        const deliverable = extractDeliverable(events)
        const files = snapshotFiles(runDir)
        return {
          label: request.label,
          runId: request.runId,
          runDir,
          ok: true,
          delivered: deliverable.length > 0 || Object.keys(files).length > 0,
          transcript: renderTrajectory(events) || "(no events recorded)",
          deliverable,
          deliverableFiles: files,
          error: "",
          costUsd: 0,
          wallS: (Date.now() - started) / 1000,
        }
      } catch (error) {
        return {
          label: request.label,
          runId: request.runId,
          runDir,
          ok: false,
          delivered: false,
          transcript: "",
          deliverable: "",
          deliverableFiles: {},
          error: error instanceof Error ? error.message : String(error),
          costUsd: 0,
          wallS: (Date.now() - started) / 1000,
        }
      }
    },
  }

  const session: SessionPort = {
    async run(request: HarnessSessionRequest): Promise<HarnessSessionResult> {
      const started = Date.now()
      const events = await call(
        request.workspace,
        request.mission,
        request.system.trim().length > 0
          ? request.system
          : [
              "You are the harness editor for Nemo, a terminal coding agent.",
              "Your evidence is on disk under `context/`. Read it before deciding.",
              "Edit `context/harness/` in place; your edits ARE the proposal.",
            ].join("\n"),
      )
      const text = extractDeliverable(events)
      return {
        text,
        ok: text.trim().length > 0,
        costUsd: 0,
        wallS: (Date.now() - started) / 1000,
        error: text.trim().length > 0 ? "" : "empty reply",
      }
    },
  }

  return { rollout, session, workDir, baseHarnessDir }
}

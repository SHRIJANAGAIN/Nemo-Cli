/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Improver sessions with file access in an isolated context workspace.
 *
 * The workspace is a copy: a session may edit `context/harness/` freely,
 * and only the harvested harness comes back. The evidence the session read
 * is never mutated, so a failed attempt cannot poison the next one.
 *
 * Every call is content-addressed, audited, and retried at the transport
 * level. A call that produces no usable reply raises `ProposerError`; it is
 * never swallowed into an empty string, because an empty reply that looks
 * like "keep the base" would silently disable improvement.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { HarnessReply } from "./types.js"
import type { SessionPort } from "./ports.js"
import { copyTree, safeName } from "./context.js"

/** A call did not produce a usable reply. Never swallowed into an empty string. */
export class ProposerError extends Error {
  readonly attempts: number
  readonly costUsd: number

  constructor(message: string, input: { attempts?: number; costUsd?: number } = {}) {
    super(message)
    this.name = "ProposerError"
    this.attempts = Math.max(0, Math.trunc(input.attempts ?? 0))
    this.costUsd = input.costUsd ?? 0
  }
}

export interface ProposerOptions {
  session: SessionPort
  /** Where mission/system/response/meta and harvested workspaces are kept. */
  auditDir?: string | null
  /** Transport attempts per call. Default 2. */
  attempts?: number
  /** The system prompt every session receives. */
  system?: string
  /** Injected so tests never wait. */
  sleep?: (ms: number) => Promise<void>
  /** The subdirectory of the workspace to harvest. Default `context/harness`. */
  harvest?: string
}

/** One call's overrides. */
export interface ProposerCallOptions {
  system?: string
  /** Override the harvested subpath, or pass "" for no harvest. */
  harvest?: string | null
  maxAttempts?: number
  timeoutMs?: number
}

interface Paths {
  mission: string
  system: string
  response: string
  meta: string
  workspace: string
}

export class Proposer {
  private readonly session: SessionPort
  private readonly auditDir: string | null
  private readonly attempts: number
  private readonly system: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly harvest: string
  readonly calls: HarnessReply[] = []

  constructor(options: ProposerOptions) {
    this.session = options.session
    this.auditDir = options.auditDir ?? null
    this.attempts = Math.max(1, Math.trunc(options.attempts ?? 2))
    this.system = options.system ?? ""
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.harvest = options.harvest ?? "context/harness"
  }

  /** Everything spent through this proposer, in USD. */
  get usd(): number {
    return round(this.calls.reduce((acc, call) => acc + call.costUsd, 0))
  }

  /** Every physical model call made, cached ones included. */
  get attemptsSpent(): number {
    return this.calls.reduce((acc, call) => acc + (call.cached ? 0 : call.attempts), 0)
  }

  /**
   * Run one session. Raises `ProposerError` if no usable reply arrives.
   *
   * `harvest` names a subpath of the session's working directory to copy
   * out before that directory is destroyed — `context/harness`, which is
   * how an edited tree comes back.
   */
  async call(
    mission: string,
    contextDir: string | null,
    label: string,
    options: ProposerCallOptions = {},
  ): Promise<HarnessReply> {
    const system = options.system ?? this.system
    const harvest =
      options.harvest === null ? null : options.harvest === undefined ? this.harvest : options.harvest
    const cacheKey = callFingerprint(label, mission, system, contextDir)

    const cached = this.readCache(label, cacheKey, harvest !== null && harvest.length > 0)
    if (cached !== null) {
      this.calls.push(cached)
      return cached
    }

    const tries = Math.max(1, Math.trunc(options.maxAttempts ?? this.attempts))
    const started = Date.now()
    let last = ""
    let spentUsd = 0
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) await this.sleep(10 * (attempt - 1) * 10)
      const scratch = fs.mkdtempSync(path.join(scratchRoot(), "nemo-session-"))
      try {
        if (contextDir !== null && isDirectory(contextDir)) {
          copyTree(contextDir, path.join(scratch, "context"))
        }
        let result: { text: string; ok?: boolean; costUsd?: number; error?: string }
        try {
          result = await this.session.run({
            label,
            mission,
            system,
            workspace: scratch,
            timeoutMs: options.timeoutMs,
          })
        } catch (error) {
          last = describe(error)
          continue
        }
        spentUsd += finite(result.costUsd)
        const text = typeof result.text === "string" ? result.text : ""
        if (result.ok === false) {
          last = result.error?.trim() || "session reported failure"
          continue
        }
        if (text.trim().length === 0) {
          last = result.error?.trim() || "empty reply"
          continue
        }

        const reply: HarnessReply = {
          label,
          text,
          ok: true,
          costUsd: round(spentUsd),
          wallS: round((Date.now() - started) / 1000),
          attempts: attempt,
          cached: false,
          error: "",
          auditDir: this.auditDir,
          workspace: null,
        }
        if (harvest !== null && harvest.length > 0) {
          reply.workspace = this.harvestWorkspace(scratch, harvest, label, cacheKey)
        }
        this.writeAudit(reply, mission, system, cacheKey)
        this.calls.push(reply)
        return reply
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
      }
    }

    const failed: HarnessReply = {
      label,
      text: "",
      ok: false,
      costUsd: round(spentUsd),
      wallS: round((Date.now() - started) / 1000),
      attempts: tries,
      cached: false,
      error: last,
      auditDir: this.auditDir,
      workspace: null,
    }
    this.calls.push(failed)
    this.writeAudit(failed, mission, system, cacheKey)
    throw new ProposerError(`[${label}] ${last || "no usable reply"}`, {
      attempts: tries,
      costUsd: spentUsd,
    })
  }

  /** Copy `scratch/<sub>` somewhere durable before the session directory is removed. */
  private harvestWorkspace(
    scratch: string,
    sub: string,
    label: string,
    cacheKey: string,
  ): string | null {
    const src = path.join(scratch, sub)
    if (!isDirectory(src)) return null
    const base =
      this.auditDir ??
      fs.mkdtempSync(path.join(scratchRoot(), "nemo-harvest-"))
    const dest = path.join(base, `${safeName(label)}.${cacheKey}.workspace`)
    fs.rmSync(dest, { recursive: true, force: true })
    copyTree(src, dest)
    return dest
  }

  private paths(label: string, cacheKey: string): Paths | null {
    if (this.auditDir === null) return null
    const dir = this.auditDir
    fs.mkdirSync(dir, { recursive: true })
    const base = path.join(dir, `${safeName(label)}.${cacheKey}`)
    return {
      mission: `${base}.mission.md`,
      system: `${base}.system.md`,
      response: `${base}.response.md`,
      meta: `${base}.meta.json`,
      workspace: `${base}.workspace`,
    }
  }

  private readCache(label: string, cacheKey: string, requireWorkspace: boolean): HarnessReply | null {
    const paths = this.paths(label, cacheKey)
    if (paths === null || !fs.existsSync(paths.response)) return null
    if (requireWorkspace && !isDirectory(paths.workspace)) return null
    let text: string
    try {
      text = fs.readFileSync(paths.response, "utf8")
    } catch {
      return null
    }
    if (text.trim().length === 0) return null
    return {
      label,
      text,
      ok: true,
      costUsd: 0,
      wallS: 0,
      attempts: 0,
      cached: true,
      error: "",
      auditDir: this.auditDir,
      workspace: isDirectory(paths.workspace) ? paths.workspace : null,
    }
  }

  private writeAudit(reply: HarnessReply, mission: string, system: string, cacheKey: string): void {
    const paths = this.paths(reply.label, cacheKey)
    if (paths === null) return
    try {
      fs.writeFileSync(paths.mission, mission, "utf8")
      if (system.length > 0) fs.writeFileSync(paths.system, system, "utf8")
      fs.writeFileSync(paths.response, reply.text, "utf8")
      fs.writeFileSync(
        paths.meta,
        JSON.stringify(
          {
            label: reply.label,
            ok: reply.ok,
            attempts: reply.attempts,
            wallS: reply.wallS,
            costUsd: reply.costUsd,
            cached: reply.cached,
            error: reply.error,
          },
          null,
          2,
        ),
        "utf8",
      )
    } catch {
      /* an audit failure must not invalidate a real reply */
    }
  }
}

/**
 * Content-address one call, including its evidence.
 *
 * The resolved path is part of the key: the two modes can have
 * byte-identical k=1 evidence and must still be independent draws.
 */
export function callFingerprint(
  label: string,
  mission: string,
  system: string,
  contextDir: string | null,
): string {
  const hash = createHash("sha256")
  for (const value of [label, mission, system]) {
    hash.update(value)
    hash.update("\0")
  }
  if (contextDir !== null) {
    hash.update(path.resolve(contextDir))
    hash.update("\0")
    if (isDirectory(contextDir)) {
      for (const file of walkFiles(contextDir)) {
        const rel = path.relative(contextDir, file).replace(/\\/g, "/")
        hash.update(rel)
        hash.update("\0")
        try {
          hash.update(fs.readFileSync(file))
        } catch (error) {
          hash.update(`<unreadable:${describe(error)}>`)
        }
        hash.update("\0")
      }
    }
  }
  return hash.digest("hex").slice(0, 16)
}

/** Every file under `dir`, sorted, skipping VCS and dependency trees. */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  visit(dir)
  return out
}

function scratchRoot(): string {
  return os.tmpdir()
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

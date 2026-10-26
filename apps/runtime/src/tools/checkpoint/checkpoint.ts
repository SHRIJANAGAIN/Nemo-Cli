/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * nemo__Checkpoint — copy explicit files into
 * `.nemo/checkpoints/<id>/files/<mirrored-path>` with a sha256 manifest so
 * nemo__Rewind can put them back byte-for-byte.
 *
 * Coexists with the automatic CheckpointStore (../../checkpoints.ts): that store
 * owns `objects/`, `cp-NNNN/` and `stacks.json` under the same root, while this
 * tool only ever creates its own `<uuid>/` directories and never reads or deletes
 * the store's layout.
 *
 * Every caller-supplied path goes through the shared guards in ../types.ts
 * (`resolveConstrainedPath` + `assertExternalDirectory`) plus a stricter
 * cwd-only rule, so a snapshot can never reach outside the workspace. Refusals
 * are structured tool results, not throws, and the manifest is written last so
 * an interrupted snapshot stays invisible to rewind.
 */

import { createHash, randomUUID } from "crypto"
import * as fs from "fs"
import * as path from "path"
import {
  assertExternalDirectory,
  resolveConstrainedPath,
  textResult,
  type Tool,
  type ToolContext,
  type ToolDefinition,
} from "../types.js"

/** Per-file ceiling — larger files are refused, never silently skipped. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Ceiling across every entry of a single checkpoint. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024

export interface CheckpointEntry {
  /** Workspace-relative POSIX path of the snapshotted file. */
  path: string
  /** sha256 (hex) of the snapshotted bytes. */
  hash: string
  size: number
}

export interface CheckpointManifest {
  id: string
  label: string | null
  timestamp: string
  entries: CheckpointEntry[]
}

/** Path probe outcomes: either a validated target or a refusal to report. */
export type PathRefusal = { ok: false; message: string }
export type SourceProbe = { ok: true; target: string; rel: string; size: number } | PathRefusal
export type TargetProbe = { ok: true; target: string; rel: string; exists: boolean } | PathRefusal

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__Checkpoint",
  description:
    "Snapshot files into .nemo/checkpoints/<id>/ (sha256 manifest) so nemo__Rewind can restore them byte-for-byte.",
  parameters: {
    type: "object",
    required: ["paths"],
    properties: {
      label: {
        type: "string",
        description: "Optional label stored in the manifest; usable as the checkpoint_id when rewinding.",
      },
      paths: {
        type: "array",
        items: { type: "string", description: "Workspace-relative file path." },
        description: "Files to snapshot. Each path must resolve inside the workspace cwd.",
      },
    },
  },
}

/** Root shared with CheckpointStore: `<cwd>/.nemo/checkpoints`. */
export function checkpointsRoot(cwd: string): string {
  return path.join(cwd, ".nemo", "checkpoints")
}

/** True when `target` is `base` itself or a path below it. */
function within(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  if (path.isAbsolute(rel)) return false
  return rel === "" || rel.split(path.sep)[0] !== ".."
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/**
 * Resolve a caller-supplied path with the shared guards — never weaker than
 * `resolveConstrainedPath` + `assertExternalDirectory`, plus a cwd-only rule so
 * a checkpoint only ever touches files inside the workspace (home-dir paths
 * such as `~/notes.md` are refused here even though read_file allows them).
 * Throws; callers turn the failure into a structured `Access denied` result.
 */
export function resolveWorkspacePath(rawPath: string, cwd: string): string {
  const resolved = resolveConstrainedPath(rawPath, cwd)
  assertExternalDirectory(resolved, cwd)
  const rel = path.relative(cwd, resolved)
  if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") {
    throw new Error(`path escapes the workspace (${resolved})`)
  }
  return resolved
}

/**
 * Refuse a path that reaches outside the workspace through a symlink: the leaf
 * itself when it is a link, and every existing ancestor directory (a
 * `src -> C:\elsewhere` parent would otherwise smuggle reads or writes out of
 * the workspace). Both tools call this before reading a snapshot source and
 * before writing a restore target. Throws.
 */
export function assertNoSymlinkEscape(target: string, cwd: string): void {
  const leaf = lstatOrNull(target)
  if (leaf !== null && leaf.isSymbolicLink()) {
    const real = realpathOrNull(target)
    if (real === null || !within(cwd, real)) {
      throw new Error(`symlink target escapes the workspace (${target})`)
    }
  }
  let dir = path.dirname(target)
  for (;;) {
    const real = realpathOrNull(dir)
    if (real !== null) {
      if (!within(cwd, real)) throw new Error(`symlinked directory escapes the workspace (${dir})`)
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/**
 * Shared validation for both tools: constrained resolution, symlink-escape
 * refusal and the rule that neither a snapshot nor a restore may touch the
 * checkpoint store itself (that would recurse into its own storage).
 */
function probePath(rawPath: string, cwd: string): { ok: true; target: string; rel: string } | PathRefusal {
  let target: string
  try {
    target = resolveWorkspacePath(rawPath, cwd)
    assertNoSymlinkEscape(target, cwd)
  } catch (error) {
    return { ok: false, message: `Access denied: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (within(checkpointsRoot(cwd), target)) {
    return { ok: false, message: `Refusing to touch checkpoint storage: ${rawPath}` }
  }
  return { ok: true, target, rel: path.relative(cwd, target).split(path.sep).join("/") }
}

/** Validate a snapshot source: it must exist and be a regular file. */
export function probeSource(rawPath: string, cwd: string): SourceProbe {
  const base = probePath(rawPath, cwd)
  if (!base.ok) return base
  if (lstatOrNull(base.target) === null) return { ok: false, message: `File not found: ${rawPath}` }
  const info = fs.statSync(base.target)
  if (!info.isFile()) return { ok: false, message: `Not a regular file: ${rawPath}` }
  return { ok: true, target: base.target, rel: base.rel, size: info.size }
}

/** Validate a restore target: it may not exist yet (the restore creates it). */
export function probeTarget(rawPath: string, cwd: string): TargetProbe {
  const base = probePath(rawPath, cwd)
  if (!base.ok) return base
  if (lstatOrNull(base.target) === null) return { ...base, exists: false }
  const info = fs.statSync(base.target)
  if (!info.isFile()) return { ok: false, message: `Not a regular file: ${rawPath}` }
  return { ...base, exists: true }
}

/** sha256 (hex) of the exact bytes that get stored. */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Write via tmp + rename so no reader ever observes a half-written file. */
export function atomicWriteFile(dest: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, dest)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup of the temp file */
    }
    throw error
  }
}

export function createCheckpointTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const rawPaths = Array.isArray(args.paths) ? args.paths : []
        if (rawPaths.length === 0) return textResult("Missing or empty 'paths'.", /*isError*/ true)
        const label = typeof args.label === "string" && args.label.trim().length > 0 ? args.label.trim() : null

        // Validate every path before touching disk: a refusal must leave no
        // half-written checkpoint behind.
        const selected: Array<{ target: string; rel: string; size: number }> = []
        const seen = new Set<string>()
        let total = 0
        for (const raw of rawPaths) {
          if (typeof raw !== "string" || raw.trim().length === 0) {
            return textResult("Every 'paths' entry must be a non-empty string.", /*isError*/ true)
          }
          const probe = probeSource(raw, ctx.cwd)
          if (!probe.ok) return textResult(probe.message, /*isError*/ true)
          if (probe.size > MAX_FILE_BYTES) {
            return textResult(
              `Refusing to snapshot ${raw}: ${probe.size} bytes exceeds the ${MAX_FILE_BYTES}-byte per-file cap.`,
              /*isError*/ true,
            )
          }
          if (seen.has(probe.rel)) continue
          seen.add(probe.rel)
          total += probe.size
          if (total > MAX_TOTAL_BYTES) {
            return textResult(
              `Refusing to snapshot: total would exceed the ${MAX_TOTAL_BYTES}-byte checkpoint cap.`,
              /*isError*/ true,
            )
          }
          selected.push({ target: probe.target, rel: probe.rel, size: probe.size })
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)

        const id = randomUUID()
        const filesRoot = path.join(checkpointsRoot(ctx.cwd), id, "files")
        const entries: CheckpointEntry[] = []
        let bytes = 0
        for (const item of selected) {
          const data = fs.readFileSync(item.target)
          // Re-check after the read: the file may have grown since validation.
          if (data.length > MAX_FILE_BYTES) {
            return textResult(
              `Refusing to snapshot ${item.rel}: ${data.length} bytes exceeds the ${MAX_FILE_BYTES}-byte per-file cap.`,
              /*isError*/ true,
            )
          }
          bytes += data.length
          if (bytes > MAX_TOTAL_BYTES) {
            return textResult(
              `Refusing to snapshot: total would exceed the ${MAX_TOTAL_BYTES}-byte checkpoint cap.`,
              /*isError*/ true,
            )
          }
          atomicWriteFile(path.join(filesRoot, item.rel), data)
          entries.push({ path: item.rel, hash: sha256Hex(data), size: data.length })
          if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        }

        // Manifest last: until it exists the directory is invisible to rewind.
        const manifest: CheckpointManifest = {
          id,
          label,
          timestamp: new Date().toISOString(),
          entries,
        }
        atomicWriteFile(
          path.join(checkpointsRoot(ctx.cwd), id, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        )

        const lines = [
          `Checkpoint created: ${id}`,
          ...(label !== null ? [`Label: ${label}`] : []),
          `Files: ${entries.length} (${bytes} bytes)`,
          ...entries.map((entry) => `  ${entry.path}  sha256:${entry.hash}  ${entry.size} bytes`),
        ]
        return textResult(lines.join("\n"))
      } catch (error) {
        return textResult(
          `Checkpoint error: ${error instanceof Error ? error.message : String(error)}`,
          /*isError*/ true,
        )
      }
    },
  }
}

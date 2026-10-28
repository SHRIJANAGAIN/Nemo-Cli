/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * nemo__Rewind — restore files snapshotted by nemo__Checkpoint.
 *
 * The current bytes of every file about to be overwritten are stashed under
 * `<id>/replaced/<mirrored-path>` first, so a rewind is itself recoverable by
 * hand. Everything (checkpoint resolution, manifest shape, subset matching,
 * destination guards, blob presence, size caps, sha256 integrity) is validated
 * before the first write, so a refusal never leaves a half-restored workspace
 * and current bytes are never destroyed unverified. Refusals are structured
 * tool results, not throws.
 *
 * `checkpoint_id` is never joined into a path: exact-id lookup only accepts a
 * safe directory name, and label lookup compares against manifest fields of
 * directories discovered with readdir. The CheckpointStore's `cp-NNNN/`,
 * `objects/` and `stacks.json` are skipped because their manifests do not parse
 * as this tool's shape.
 */

import * as fs from "fs"
import * as path from "path"
import { textResult, type Tool, type ToolContext, type ToolDefinition } from "../types.js"
import {
  atomicWriteFile,
  checkpointsRoot,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  probeTarget,
  sha256Hex,
  type CheckpointEntry,
  type CheckpointManifest,
  type PathRefusal,
} from "./checkpoint.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__Rewind",
  description:
    "Restore files from a .nemo/checkpoints/<id> snapshot, stashing the current bytes under <id>/replaced/ first. 'checkpoint_id' may be the id or the label.",
  parameters: {
    type: "object",
    required: ["checkpoint_id"],
    properties: {
      checkpoint_id: { type: "string", description: "Checkpoint id, or the label passed to nemo__Checkpoint." },
      paths: {
        type: "array",
        items: { type: "string", description: "Workspace-relative file path." },
        description: "Restore only these files. Omit (or pass an empty list) to restore every file in the checkpoint.",
      },
    },
  },
}

type ResolveResult = { ok: true; dir: string; manifest: CheckpointManifest } | PathRefusal

interface PlannedRestore {
  entry: CheckpointEntry
  target: string
  exists: boolean
  data: Buffer
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function readTextOrNull(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf8")
  } catch {
    return null
  }
}

/** Parse a manifest; returns null for any shape this tool did not write. */
function parseManifest(raw: string): CheckpointManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.id !== "string" || !Array.isArray(record.entries)) return null
  const entries: CheckpointEntry[] = []
  for (const item of record.entries) {
    if (typeof item !== "object" || item === null) return null
    const field = item as Record<string, unknown>
    if (typeof field.path !== "string" || typeof field.hash !== "string" || typeof field.size !== "number") return null
    entries.push({ path: field.path, hash: field.hash, size: field.size })
  }
  return {
    id: record.id,
    label: typeof record.label === "string" ? record.label : null,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
    entries,
  }
}

function loadManifest(dir: string): CheckpointManifest | null {
  const raw = readTextOrNull(path.join(dir, "manifest.json"))
  return raw === null ? null : parseManifest(raw)
}

/** A manifest path may be relative and inside its checkpoint — nothing else. */
function isSafeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false
  return !candidate.split(/[\\/]/).some((segment) => segment === "..")
}

/**
 * Resolve the checkpoint the caller means: an exact id directory first, then
 * the newest manifest whose label (or id) matches. `checkpoint_id` is only ever
 * used as a directory name after passing the id pattern below.
 */
function resolveCheckpoint(root: string, checkpointId: string): ResolveResult {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(checkpointId)) {
    const dir = path.join(root, checkpointId)
    const info = statOrNull(dir)
    if (info !== null && info.isDirectory()) {
      const manifest = loadManifest(dir)
      return manifest === null
        ? { ok: false, message: `Checkpoint manifest missing or corrupt: ${checkpointId}` }
        : { ok: true, dir, manifest }
    }
  }

  let names: string[] = []
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    names = []
  }
  let best: { dir: string; manifest: CheckpointManifest } | null = null
  for (const name of names) {
    const dir = path.join(root, name)
    const manifest = loadManifest(dir)
    if (manifest === null) continue
    const matches = manifest.id === checkpointId || (manifest.label !== null && manifest.label === checkpointId)
    if (!matches) continue
    if (best === null || manifest.timestamp >= best.manifest.timestamp) best = { dir, manifest }
  }
  if (best === null) return { ok: false, message: `Unknown checkpoint: ${checkpointId}` }
  return { ok: true, dir: best.dir, manifest: best.manifest }
}

/** Locate a manifest entry's stored bytes inside its checkpoint directory. */
function locateBlob(dir: string, entry: CheckpointEntry): { ok: true; blob: string } | PathRefusal {
  const filesRoot = path.join(dir, "files")
  if (!isSafeRelativePath(entry.path)) {
    return { ok: false, message: `Corrupt checkpoint manifest: unsafe path "${entry.path}"` }
  }
  const blob = path.join(filesRoot, entry.path)
  const rel = path.relative(filesRoot, blob)
  if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") {
    return { ok: false, message: `Corrupt checkpoint manifest: unsafe path "${entry.path}"` }
  }
  return { ok: true, blob }
}

export function createRewindTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const checkpointId = typeof args.checkpoint_id === "string" ? args.checkpoint_id.trim() : ""
        if (checkpointId.length === 0) return textResult("Missing 'checkpoint_id'.", /*isError*/ true)

        const resolved = resolveCheckpoint(checkpointsRoot(ctx.cwd), checkpointId)
        if (!resolved.ok) return textResult(resolved.message, /*isError*/ true)
        const dir = resolved.dir
        const manifest = resolved.manifest

        const rawPaths = Array.isArray(args.paths) ? args.paths : []
        let selected = manifest.entries
        if (rawPaths.length > 0) {
          const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]))
          const wanted: CheckpointEntry[] = []
          for (const raw of rawPaths) {
            if (typeof raw !== "string" || raw.trim().length === 0) {
              return textResult("Every 'paths' entry must be a non-empty string.", /*isError*/ true)
            }
            const probe = probeTarget(raw, ctx.cwd)
            if (!probe.ok) return textResult(probe.message, /*isError*/ true)
            const entry = byPath.get(probe.rel)
            if (entry === undefined) return textResult(`Not in checkpoint ${manifest.id}: ${raw}`, /*isError*/ true)
            wanted.push(entry)
          }
          selected = wanted
        }

        // Validate every restore before the first write: blob presence and
        // integrity, size caps, and the destination guards. Blobs are read here
        // so the caps also bound how much this tool can hold in memory.
        const planned: PlannedRestore[] = []
        let total = 0
        for (const entry of selected) {
          const located = locateBlob(dir, entry)
          if (!located.ok) return textResult(located.message, /*isError*/ true)
          const dest = probeTarget(entry.path, ctx.cwd)
          if (!dest.ok) return textResult(dest.message, /*isError*/ true)
          const blobInfo = statOrNull(located.blob)
          if (blobInfo === null || !blobInfo.isFile()) {
            return textResult(`Checkpoint blob missing: ${entry.path}`, /*isError*/ true)
          }
          if (blobInfo.size > MAX_FILE_BYTES) {
            return textResult(
              `Refusing to restore ${entry.path}: ${blobInfo.size} bytes exceeds the ${MAX_FILE_BYTES}-byte per-file cap.`,
              /*isError*/ true,
            )
          }
          total += blobInfo.size
          if (total > MAX_TOTAL_BYTES) {
            return textResult(
              `Refusing to rewind: total would exceed the ${MAX_TOTAL_BYTES}-byte checkpoint cap.`,
              /*isError*/ true,
            )
          }
          const data = fs.readFileSync(located.blob)
          if (sha256Hex(data) !== entry.hash) {
            return textResult(`Checkpoint blob corrupted (sha256 mismatch): ${entry.path}`, /*isError*/ true)
          }
          planned.push({ entry, target: dest.target, exists: dest.exists, data })
          if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        }

        let restored = 0
        let stashed = 0
        const details: string[] = []
        for (const item of planned) {
          if (signal?.aborted) return textResult("aborted", /*isError*/ true)
          if (item.exists) {
            const current = fs.readFileSync(item.target)
            atomicWriteFile(path.join(dir, "replaced", item.entry.path), current)
            stashed += 1
          }
          atomicWriteFile(item.target, item.data)
          restored += 1
          details.push(`  ${item.entry.path} restored${item.exists ? " (previous copy stashed)" : " (file created)"}`)
        }

        return textResult(
          [
            `Rewind complete: ${manifest.id}`,
            `Restored ${restored} file(s); stashed ${stashed} previous copy(ies).`,
            ...details,
          ].join("\n"),
        )
      } catch (error) {
        return textResult(`Rewind error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}

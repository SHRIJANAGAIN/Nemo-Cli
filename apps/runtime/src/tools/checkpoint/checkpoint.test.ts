/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createCheckpointTool, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./checkpoint.js"
import { createRewindTool } from "./rewind.js"
import type { ToolContext, ToolResult } from "../types.js"

const dirs: string[] = []

function tmpCtx(): { dir: string; ctx: ToolContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-checkpoint-"))
  dirs.push(dir)
  return { dir, ctx: { cwd: dir } as unknown as ToolContext }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text ?? "").join("\n")
}

function checkpointRoot(dir: string): string {
  return path.join(dir, ".trayambak", "checkpoints")
}

function readManifest(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(checkpointRoot(dir), id, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >
}

/** Run the checkpoint tool and return its result, asserting success. */
async function checkpoint(dir: string, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await createCheckpointTool().execute("cp", args, undefined, undefined, ctx)
  expect(result.isError, resultText(result)).toBe(false)
  return result
}

/** Id recorded on the first line: `Checkpoint created: <id>`. */
function checkpointId(result: ToolResult): string {
  const first = resultText(result).split("\n")[0]
  return first.replace("Checkpoint created: ", "")
}

async function rewind(ctx: ToolContext, args: Record<string, unknown>): Promise<{ result: ToolResult; text: string }> {
  const result = await createRewindTool().execute("rw", args, undefined, undefined, ctx)
  return { result, text: resultText(result) }
}

function supportsSymlinks(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-symlink-probe-"))
  try {
    const target = path.join(probeDir, "target.txt")
    fs.writeFileSync(target, "x", "utf8")
    fs.symlinkSync(target, path.join(probeDir, "link.txt"), "file")
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
}

const SYMLINKS_SUPPORTED = supportsSymlinks()

function supportsDirectorySymlinks(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-junction-probe-"))
  try {
    const target = path.join(probeDir, "target")
    fs.mkdirSync(target)
    // Windows junctions need no elevated privilege; other platforms ignore the type.
    fs.symlinkSync(target, path.join(probeDir, "link"), "junction")
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
}

const DIRECTORY_SYMLINKS_SUPPORTED = supportsDirectorySymlinks()

describe("trayambak__Checkpoint + trayambak__Rewind round trip", () => {
  it("restores snapshotted bytes and stashes the current ones", async () => {
    const { dir, ctx } = tmpCtx()
    fs.mkdirSync(path.join(dir, "src"))
    const originalA = "export const a = 1\n"
    const originalB = "before rewrite\n"
    fs.writeFileSync(path.join(dir, "src", "a.ts"), originalA, "utf8")
    fs.writeFileSync(path.join(dir, "b.txt"), originalB, "utf8")

    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["src/a.ts", "b.txt"] }))

    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2\n", "utf8")
    fs.writeFileSync(path.join(dir, "b.txt"), "after rewrite\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: id })
    expect(result.isError, text).toBe(false)
    expect(text).toContain(`Rewind complete: ${id}`)
    expect(text).toContain("Restored 2 file(s); stashed 2 previous copy(ies).")
    expect(fs.readFileSync(path.join(dir, "src", "a.ts"), "utf8")).toBe(originalA)
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe(originalB)

    const replaced = path.join(checkpointRoot(dir), id, "replaced")
    expect(fs.readFileSync(path.join(replaced, "b.txt"), "utf8")).toBe("after rewrite\n")
    expect(fs.readFileSync(path.join(replaced, "src", "a.ts"), "utf8")).toBe("export const a = 2\n")
  })

  it("rewind by label finds the checkpoint recorded with that label", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "app.ts"), "labelled\n", "utf8")
    await checkpoint(dir, ctx, { paths: ["app.ts"], label: "before refactor" })
    fs.writeFileSync(path.join(dir, "app.ts"), "mutated\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: "before refactor" })
    expect(result.isError, text).toBe(false)
    expect(text).toContain("Restored 1 file(s); stashed 1 previous copy(ies).")
    expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe("labelled\n")
  })

  it("restores only the requested subset", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "keep.ts"), "keep original\n", "utf8")
    fs.writeFileSync(path.join(dir, "other.ts"), "other original\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["keep.ts", "other.ts"] }))

    fs.writeFileSync(path.join(dir, "keep.ts"), "keep mutated\n", "utf8")
    fs.writeFileSync(path.join(dir, "other.ts"), "other mutated\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: id, paths: ["keep.ts"] })
    expect(result.isError, text).toBe(false)
    expect(text).toContain("Restored 1 file(s); stashed 1 previous copy(ies).")
    expect(fs.readFileSync(path.join(dir, "keep.ts"), "utf8")).toBe("keep original\n")
    expect(fs.readFileSync(path.join(dir, "other.ts"), "utf8")).toBe("other mutated\n")
  })

  it("recreates a file that was deleted after the checkpoint", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "gone.txt"), "still here\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["gone.txt"] }))
    fs.rmSync(path.join(dir, "gone.txt"))

    const { result, text } = await rewind(ctx, { checkpoint_id: id })
    expect(result.isError, text).toBe(false)
    expect(text).toContain("Restored 1 file(s); stashed 0 previous copy(ies).")
    expect(text).toContain("(file created)")
    expect(fs.readFileSync(path.join(dir, "gone.txt"), "utf8")).toBe("still here\n")
  })
})

describe("trayambak__Checkpoint manifest", () => {
  it("records the sha256 and size of exactly the bytes it stored", async () => {
    const { dir, ctx } = tmpCtx()
    fs.mkdirSync(path.join(dir, "src"))
    const content = "const value = 'hashed'\n"
    fs.writeFileSync(path.join(dir, "src", "hash.ts"), content, "utf8")

    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["src/hash.ts"], label: "label one" }))
    const manifest = readManifest(dir, id)
    const entries = manifest.entries as Array<{ path: string; hash: string; size: number }>

    expect(manifest.id).toBe(id)
    expect(manifest.label).toBe("label one")
    expect(typeof manifest.timestamp).toBe("string")
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe("src/hash.ts")
    expect(entries[0].size).toBe(Buffer.byteLength(content, "utf8"))
    expect(entries[0].hash).toBe(createHash("sha256").update(content, "utf8").digest("hex"))

    const stored = path.join(checkpointRoot(dir), id, "files", "src", "hash.ts")
    expect(fs.readFileSync(stored, "utf8")).toBe(content)
  })
})

describe("trayambak__Checkpoint refusals", () => {
  it("reports a missing file as a structured error and writes nothing", async () => {
    const { dir, ctx } = tmpCtx()
    const result = await createCheckpointTool().execute("cp", { paths: ["nope.txt"] }, undefined, undefined, ctx)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("not found")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it("refuses an empty paths list", async () => {
    const { ctx } = tmpCtx()
    const result = await createCheckpointTool().execute("cp", { paths: [] }, undefined, undefined, ctx)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("Missing or empty 'paths'")
  })

  it("refuses relative escapes outside the workspace", async () => {
    const { dir, ctx } = tmpCtx()
    const result = await createCheckpointTool().execute(
      "cp",
      { paths: ["../../etc/passwd"] },
      undefined,
      undefined,
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("Access denied")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it("refuses an absolute path outside the workspace cwd", async () => {
    const { ctx } = tmpCtx()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-checkpoint-outside-"))
    dirs.push(outside)
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8")

    const result = await createCheckpointTool().execute(
      "cp",
      { paths: [path.join(outside, "secret.txt")] },
      undefined,
      undefined,
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("Access denied")
  })

  it("refuses rewind paths that escape the workspace", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "a.txt"), "content\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["a.txt"] }))
    fs.writeFileSync(path.join(dir, "a.txt"), "mutated\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: id, paths: ["../../etc/passwd"] })
    expect(result.isError).toBe(true)
    expect(text).toContain("Access denied")
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("mutated\n")
  })

  it("refuses a file over the 10MB per-file cap without creating storage", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))

    const result = await createCheckpointTool().execute("cp", { paths: ["big.bin"] }, undefined, undefined, ctx)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("per-file cap")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it("refuses a snapshot over the 100MB total cap without creating storage", async () => {
    const { dir, ctx } = tmpCtx()
    const paths: string[] = []
    const chunk = Buffer.alloc(9_600_000, 0x62)
    for (let i = 0; i < 11; i += 1) {
      const name = `part-${i}.bin`
      fs.writeFileSync(path.join(dir, name), chunk)
      paths.push(name)
    }
    expect(chunk.length * paths.length).toBeGreaterThan(MAX_TOTAL_BYTES)

    const result = await createCheckpointTool().execute("cp", { paths }, undefined, undefined, ctx)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("checkpoint cap")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it.skipIf(!SYMLINKS_SUPPORTED)("refuses a symlink whose target escapes the workspace", async () => {
    const { dir, ctx } = tmpCtx()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-checkpoint-link-"))
    dirs.push(outside)
    const outsideFile = path.join(outside, "secret.txt")
    fs.writeFileSync(outsideFile, "outside\n", "utf8")
    fs.symlinkSync(outsideFile, path.join(dir, "link.txt"), "file")

    const result = await createCheckpointTool().execute("cp", { paths: ["link.txt"] }, undefined, undefined, ctx)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("Access denied")
    expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
  })

  it.skipIf(!DIRECTORY_SYMLINKS_SUPPORTED)(
    "refuses a file reached through a directory symlink that escapes the workspace",
    async () => {
      const { dir, ctx } = tmpCtx()
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-checkpoint-dirlink-"))
      dirs.push(outside)
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8")
      fs.symlinkSync(outside, path.join(dir, "linkdir"), "junction")

      const result = await createCheckpointTool().execute(
        "cp",
        { paths: ["linkdir/secret.txt"] },
        undefined,
        undefined,
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain("Access denied")
      expect(fs.existsSync(path.join(dir, ".trayambak"))).toBe(false)
    },
  )
})

describe("trayambak__Rewind refusals", () => {
  it("refuses an unknown checkpoint id", async () => {
    const { ctx } = tmpCtx()
    const { result, text } = await rewind(ctx, { checkpoint_id: "does-not-exist" })
    expect(result.isError).toBe(true)
    expect(text).toContain("Unknown checkpoint")
  })

  it("refuses a missing checkpoint_id", async () => {
    const { ctx } = tmpCtx()
    const { result, text } = await rewind(ctx, {})
    expect(result.isError).toBe(true)
    expect(text).toContain("Missing 'checkpoint_id'")
  })

  it("refuses a checkpoint directory that has no manifest", async () => {
    const { dir, ctx } = tmpCtx()
    const orphan = path.join(checkpointRoot(dir), "manual-checkpoint")
    fs.mkdirSync(path.join(orphan, "files"), { recursive: true })
    fs.writeFileSync(path.join(orphan, "files", "a.txt"), "orphan\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: "manual-checkpoint" })
    expect(result.isError).toBe(true)
    expect(text).toContain("manifest missing or corrupt")
  })

  it("refuses to restore when the stored blob is missing", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["a.txt"] }))
    fs.writeFileSync(path.join(dir, "a.txt"), "mutated\n", "utf8")
    fs.rmSync(path.join(checkpointRoot(dir), id, "files", "a.txt"))

    const { result, text } = await rewind(ctx, { checkpoint_id: id })
    expect(result.isError).toBe(true)
    expect(text).toContain("Checkpoint blob missing")
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("mutated\n")
    expect(fs.existsSync(path.join(checkpointRoot(dir), id, "replaced"))).toBe(false)
  })

  it("refuses to restore a blob whose bytes no longer match the manifest hash", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["a.txt"] }))
    fs.writeFileSync(path.join(dir, "a.txt"), "mutated\n", "utf8")
    fs.writeFileSync(path.join(checkpointRoot(dir), id, "files", "a.txt"), "tampered\n", "utf8")

    const { result, text } = await rewind(ctx, { checkpoint_id: id })
    expect(result.isError).toBe(true)
    expect(text).toContain("sha256 mismatch")
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("mutated\n")
    expect(fs.existsSync(path.join(checkpointRoot(dir), id, "replaced"))).toBe(false)
  })

  it("refuses a subset path that is not part of the checkpoint", async () => {
    const { dir, ctx } = tmpCtx()
    fs.writeFileSync(path.join(dir, "a.txt"), "original\n", "utf8")
    fs.writeFileSync(path.join(dir, "b.txt"), "also here\n", "utf8")
    const id = checkpointId(await checkpoint(dir, ctx, { paths: ["a.txt"] }))

    const { result, text } = await rewind(ctx, { checkpoint_id: id, paths: ["b.txt"] })
    expect(result.isError).toBe(true)
    expect(text).toContain("Not in checkpoint")
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("also here\n")
  })
})

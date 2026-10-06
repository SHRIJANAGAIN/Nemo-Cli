/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Read-only mode must not write to disk.
 *
 * `artifact` is in `READ_ONLY_TOOLS` because its read actions are safe, but it
 * also creates and deletes files under `<cwd>/skt/10-upload/artifacts/` — and
 * its manager `mkdirSync`s that tree in the CONSTRUCTOR, so merely reaching
 * the tool mutated the workspace. The read-only gate matched on the tool name
 * alone, so `artifact create` was allowed in read-only and plan mode and wrote
 * `1.json` + `manifest.json` for real. `artifact` is the hermetic proof here
 * (its writes are cwd-relative); `memory` and `todo` are covered by the
 * permission-layer tests in `permission-rules.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { evaluatePermission } from "../../../../../packages/protocol/src/permission-rules.js"
import type { PermissionConfig } from "../../../../../packages/protocol/src/permissions.js"
import { createArtifactTool } from "./artifact.js"
import type { ToolContext } from "../types.js"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-ro-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) break
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

const readOnly = (): PermissionConfig =>
  ({ mode: "default", rules: [], askByDefault: false, uiMode: "read-only" }) as unknown as PermissionConfig

/** The agent loop's own order: gate first, and only reach `execute` if allowed. */
async function runGated(args: Record<string, unknown>, cwd: string): Promise<"denied" | "ran"> {
  if (evaluatePermission("artifact", args, readOnly()).action === "deny") return "denied"
  await createArtifactTool().execute("1", args, undefined, undefined, {
    config: { cwd },
    cwd,
  } as unknown as ToolContext)
  return "ran"
}

const artifactsDir = (cwd: string): string => path.join(cwd, "skt", "10-upload", "artifacts")

describe("artifact under a read-only session", () => {
  it.each([
    ["create", { filename: "report.md", content: "hello" }],
    ["update", { id: "1", content: "tampered" }],
    ["delete", { id: "1" }],
  ])("denies the writing action %s before it can touch disk", async (action, extra) => {
    expect(evaluatePermission("artifact", { action, ...extra }, readOnly()).action).toBe("deny")
    expect(evaluatePermission("artifact", { action, ...extra }, readOnly()).source).toBe("read-only-mode")

    const cwd = tempDir()
    expect(await runGated({ action, ...extra }, cwd)).toBe("denied")
    // Nothing created — not even the directory the manager's constructor
    // would have mkdir'd.
    expect(fs.existsSync(artifactsDir(cwd))).toBe(false)
  })

  it("still allows the reading actions", () => {
    for (const action of ["get", "list", "search"]) {
      expect(evaluatePermission("artifact", { action, id: "1", query: "x" }, readOnly()).action).toBe("allow")
    }
  })

  it("fails closed on an unrecognised or missing action", () => {
    for (const args of [{}, { action: "" }, { action: 42 }, { action: null }, { action: "CREATE" }]) {
      expect(evaluatePermission("artifact", args, readOnly()).action).toBe("deny")
    }
  })
})

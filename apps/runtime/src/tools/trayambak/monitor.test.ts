/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `trayambak__Monitor` child-process hygiene (#76): the model supplies the
 * `command`, so the child must get the same filtered env as `bash` (no raw
 * secret dump into context), abort must kill the child instead of hanging
 * the poll, and a missing shell binary must surface as output rather than
 * an unhandled spawn error.
 */

import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createMonitorTool } from "./monitor.js"

const node = JSON.stringify(process.execPath)

/** Writes the child's env JSON to `outFile` — probe needs no nested quotes
 *  in the -e script (path travels as argv[1]), so cmd and sh both parse it. */
function envProbeCommand(outFile: string): string {
  return `${node} -e "require('fs').writeFileSync(process.argv[1],JSON.stringify(process.env))" ${outFile}`
}

describe("trayambak__Monitor child-process hygiene (#76)", () => {
  it("runs the command with the filtered env, never raw process.env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-mon-"))
    const outFile = path.join(dir, "child-env.json")
    process.env.ZZ_TRAYAMBAK_MONITOR_PROBE_SECRET = "s3cr3t-probe"
    try {
      const tool = createMonitorTool()
      const res = await tool.execute("t1", { command: envProbeCommand(outFile), max_runs: 1 }, undefined)
      expect(res.isError).toBe(false)
      const childEnv = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, string>
      expect(childEnv.ZZ_TRAYAMBAK_MONITOR_PROBE_SECRET).toBeUndefined()
      expect(childEnv.PATH).toBeTruthy()
    } finally {
      delete process.env.ZZ_TRAYAMBAK_MONITOR_PROBE_SECRET
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it("kills the in-flight child on abort instead of hanging the poll", async () => {
    const tool = createMonitorTool()
    const controller = new AbortController()
    const command = `${node} -e "setTimeout(() => {}, 60000)"`
    const pending = tool.execute("t1", { command, interval_ms: 60_000, max_runs: 3 }, controller.signal)
    await new Promise((r) => setTimeout(r, 250))
    controller.abort()
    const started = Date.now()
    const res = await pending
    expect(Date.now() - started).toBeLessThan(5000)
    expect(res.isError).toBe(false)
  }, 15000)

  it("reports the output of a completed poll and honours pattern-less matching", async () => {
    const tool = createMonitorTool()
    const res = await tool.execute(
      "t1",
      { command: `${node} -e "process.stdout.write('tick')"`, max_runs: 1 },
      undefined,
    )
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toContain("tick")
    expect(res.content[0].text).toContain("matched=true")
  }, 15000)
})

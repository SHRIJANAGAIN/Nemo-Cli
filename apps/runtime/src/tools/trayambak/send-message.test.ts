/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSendMessageTool, sendToInbox, readInbox, type SendMessageTarget } from "./send-message.js"
import type { ToolContext } from "../types.js"

/**
 * SendMessage delivery honesty: the old tool always answered "queued in
 * inbox" even when nobody could ever read the message (finished/unknown
 * agent) — the "agent doesn't receive my message" report. Now a resolver
 * distinguishes running (delivered — the loop polls next turn),
 * finished (stored-but-unread warning), and unknown (stored-but-unread).
 *
 * Isolation: the inbox lives under the OS home dir (os.homedir() ignores a
 * reassigned USERPROFILE on win32), so every test uses a unique agent id
 * and deletes its inbox files afterwards — never touching real inboxes.
 */
describe("trayambak__SendMessage", () => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const ids: Record<string, string> = {
    roundtrip: `t-rt-${tag}`,
    run: `t-run-${tag}`,
    done: `t-done-${tag}`,
    ghost: `t-ghost-${tag}`,
  }
  const ctx = (): ToolContext => ({ cwd: "C:\\" }) as ToolContext
  const lookup = (to: string): SendMessageTarget | undefined => {
    if (to === ids.run) return { id: ids.run, name: "Long Job", running: true }
    if (to === ids.done) return { id: ids.done, name: "Old Job", running: false }
    return undefined
  }

  const outText = (res: unknown): string => {
    const r = res as { content: Array<{ type: string; text: string }>; isError: boolean }
    return r.content.map((c) => c.text).join("\n") + (r.isError ? " [isError]" : "")
  }

  beforeEach(() => {
    // Nothing to set up: ids are unique per file-run (see above).
  })

  afterEach(() => {
    for (const id of Object.values(ids)) {
      try {
        fs.rmSync(path.join(os.homedir(), ".trayambak", "inbox", `${id}.jsonl`), { force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it("round-trips through the durable inbox file", () => {
    const m = sendToInbox(ids.roundtrip, "tester", "hello there")
    expect(m.to).toBe(ids.roundtrip)
    expect(m.read).toBe(false)
    const back = readInbox(ids.roundtrip)
    expect(back).toHaveLength(1)
    expect(back[0].content).toBe("hello there")
    expect(readInbox(`t-nobody-${tag}`)).toEqual([])
  })

  it("delivers to a running job (success, no error flag)", async () => {
    const tool = createSendMessageTool(undefined, { resolveTarget: lookup })
    const res = await tool.execute("e1", { to: ids.run, content: "keep going" }, undefined, undefined, ctx())
    const text = outText(res)
    expect(text).toContain("delivered to running job")
    expect(text).not.toContain("[isError]")
    expect(readInbox(ids.run)).toHaveLength(1)
  })

  it("warns (error) when the job already finished", async () => {
    const tool = createSendMessageTool(undefined, { resolveTarget: lookup })
    const res = await tool.execute("e2", { to: ids.done, content: "are you there" }, undefined, undefined, ctx())
    const text = outText(res)
    expect(text).toContain("already finished")
    expect(text).toContain("[isError]")
  })

  it("warns (error) for unknown recipients instead of fake-queuing", async () => {
    const tool = createSendMessageTool(undefined, { resolveTarget: lookup })
    const res = await tool.execute("e3", { to: ids.ghost, content: "hi" }, undefined, undefined, ctx())
    const text = outText(res)
    expect(text).toContain(`no running agent matches "${ids.ghost}"`)
    expect(text).toContain("[isError]")
  })

  it("still validates missing fields", async () => {
    const tool = createSendMessageTool(undefined, { resolveTarget: lookup })
    const res = await tool.execute("e4", { to: "", content: "" }, undefined, undefined, ctx())
    expect(outText(res)).toContain("Missing")
  })
})

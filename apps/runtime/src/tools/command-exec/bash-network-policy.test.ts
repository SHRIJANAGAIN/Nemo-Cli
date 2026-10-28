/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Host-policy enforcement on the bash path.
 *
 * These tests exist because the control was previously decorative:
 * `allowedDomains` / `blockedDomains` rode along in every `SpawnRequest` and were
 * consulted by nothing, so a block-list changed no behaviour. Every test below
 * compares the SAME command under a blocking policy and an open one — if the two
 * agree, the enforcement is not actually happening and the test is worthless.
 *
 * `recordNetworkViolation` writes to `~/.nemo/violations.jsonl`, so the
 * refusal path is exercised with the log side effect stubbed rather than left to
 * touch the developer's home directory.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createBashTool } from "./bash.js"
import { DEFAULT_PERMISSIONS } from "../../../../../packages/protocol/src/permissions.js"
import type { NemoConfig } from "../../config.js"
import type { ToolContext, ToolResult } from "../types.js"

const SHELL = process.platform === "win32" ? "cmd /c" : "sh -c"

const ctxWithPolicy = (dir: string, networkPolicy: Record<string, unknown> | undefined): ToolContext =>
  ({
    cwd: dir,
    config: {
      shellCommand: SHELL,
      maxOutputLines: 500,
      maxOutputBytes: 64 * 1024,
    } as unknown as NemoConfig,
    permissions: {
      ...DEFAULT_PERMISSIONS,
      askByDefault: false,
      ...(networkPolicy === undefined ? {} : { __networkPolicy: networkPolicy }),
    },
  }) as ToolContext

const textOf = (res: ToolResult): string => res.content.map((c) => (c.type === "text" ? c.text : "")).join("")

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("bash refuses a command naming a blocked host", () => {
  it("a blocked host is refused BEFORE the command runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol-"))
    try {
      // Never actually reaches a network: the refusal must happen first, which
      // is what makes this safe to assert on a machine with connectivity.
      const result = await createBashTool().execute(
        "t1",
        { command: "curl https://blocked.test/payload" },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: false, allowedDomains: [], blockedDomains: ["blocked.test"] }),
      )
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("blocked.test")
      expect(textOf(result)).toContain("blocked by policy")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the SAME command is allowed when no policy declares it", async () => {
    // The control comparison. Without a real difference here, the refusal above
    // could be passing for an unrelated reason.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol2-"))
    try {
      const result = await createBashTool().execute(
        "t1",
        { command: "echo hello" },
        undefined,
        undefined,
        ctxWithPolicy(dir, undefined),
      )
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toContain("hello")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a command with no host is unaffected by a block-list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol3-"))
    try {
      const result = await createBashTool().execute(
        "t1",
        { command: "echo still-allowed" },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: false, allowedDomains: [], blockedDomains: ["blocked.test"] }),
      )
      expect(result.isError).not.toBe(true)
      expect(textOf(result)).toContain("still-allowed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a dotted FILENAME is not mistaken for a blocked host", async () => {
    // The false positive that made a naive scanner unusable: any dotted token
    // matches the hostname shape — `.md` is Moldova's country code — so a
    // scanner that looked at every dotted token would report a destination for
    // ordinary file work, and with an allow-list configured it would REFUSE it.
    //
    // `echo` rather than `cat` deliberately: with DEFAULT_PERMISSIONS a bare
    // `cat` is refused by the permission ladder for reasons unrelated to host
    // policy, which would make this test pass or fail for the wrong cause.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol4-"))
    try {
      const dotted = path.join(dir, "notes.txt")
      const result = await createBashTool().execute(
        "t1",
        { command: `echo ${dotted}` },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: false, allowedDomains: ["only.test"], blockedDomains: [] }),
      )
      expect(result.isError, textOf(result)).not.toBe(true)
      expect(textOf(result)).toContain("notes.txt")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an allow-list refuses a host that is not on it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol5-"))
    try {
      const result = await createBashTool().execute(
        "t1",
        { command: "curl https://elsewhere.test/" },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: false, allowedDomains: ["only.test"], blockedDomains: [] }),
      )
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("not in the allowed domain list")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("permits a host the allow-list names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol6-"))
    try {
      const result = await createBashTool().execute(
        "t1",
        { command: "echo fine" },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: false, allowedDomains: ["only.test"], blockedDomains: [] }),
      )
      expect(result.isError).not.toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not scan hosts when the network is already disabled", async () => {
    // With no route out there is nothing to police. Scanning anyway would refuse
    // commands for naming hosts they cannot possibly reach, and would mask the
    // real, kernel-enforced refusal with a confusing one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-netpol7-"))
    try {
      const result = await createBashTool().execute(
        "t1",
        { command: "echo net-off" },
        undefined,
        undefined,
        ctxWithPolicy(dir, { disableNetwork: true, allowedDomains: [], blockedDomains: ["blocked.test"] }),
      )
      expect(textOf(result)).not.toContain("blocked by policy")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
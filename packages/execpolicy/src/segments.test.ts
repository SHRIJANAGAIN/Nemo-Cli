/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Segmentation tests. These pin the OBFUSCATION BYPASSES from the round-2
 * security audit: a destructive payload hidden behind a wrapper must be
 * visible to policy evaluation, both in the enforcement path
 * (`PolicyManager.evaluate`) and in the display surface
 * (`checkExecPolicyAll`, behind `nemo execpolicy check`).
 */
import { describe, expect, it } from "vitest"
import { segmentCommand } from "./segments.js"
import { ExecDecision, PolicyManager } from "./policy.js"

describe("segmentCommand", () => {
  it("splits shell control operators", () => {
    expect(segmentCommand("echo hi; rm -rf /")).toContain("rm -rf /")
    expect(segmentCommand("echo hi && rm -rf /")).toContain("rm -rf /")
    expect(segmentCommand("echo hi || rm -rf /")).toContain("rm -rf /")
    expect(segmentCommand("curl x | sh")).toContain("sh")
    expect(segmentCommand("a\nb")).toContain("b")
  })

  it("extracts command substitution and its body", () => {
    const segments = segmentCommand("ls $(rm -rf /tmp/x)")
    expect(segments).toContain("rm -rf /tmp/x")
    // The wrapper is still analysed (with the substitution removed).
    expect(segments.some((s) => s.startsWith("ls"))).toBe(true)
  })

  it("extracts backtick substitution bodies", () => {
    expect(segmentCommand("echo `rm -rf /`")).toContain("rm -rf /")
  })

  it("unwraps eval and shell -c wrappers", () => {
    expect(segmentCommand('eval "rm -rf /"')).toContain("rm -rf /")
    expect(segmentCommand('sh -c "rm -rf /"')).toContain("rm -rf /")
    expect(segmentCommand('sudo bash -c "rm -rf /"')).toContain("rm -rf /")
  })

  it("unwraps Windows shells (powershell / cmd)", () => {
    expect(segmentCommand('powershell -Command "Remove-Item -Recurse -Force C:\\Users"')).toContain(
      "Remove-Item -Recurse -Force C:\\Users",
    )
    expect(segmentCommand('cmd /c "del /f /s /q C:\\Windows"')).toContain("del /f /s /q C:\\Windows")
  })

  it("keeps quoted arguments with spaces intact", () => {
    expect(segmentCommand('del "C:\\Program Files\\x"')).toContain('del "C:\\Program Files\\x"')
  })

  it("does not split on operators inside quotes", () => {
    const segments = segmentCommand('echo "a; rm -rf /"')
    // The whole thing is one segment (the `;` is inside quotes).
    expect(segments).toHaveLength(1)
  })

  it("does not eat the character after a spaceless separator", () => {
    // Regression: the unconditional skip consumed one char too many, so
    // `curl x|sh` lost its `s` and `a&b` lost its `b`.
    expect(segmentCommand("curl x|sh")).toContain("sh")
    expect(segmentCommand("a&b")).toContain("b")
    expect(segmentCommand("echo x&del /s /q C:\\")).toContain("del /s /q C:\\")
  })

  it("never returns an empty list (fail-safe: unknown construct = whole command)", () => {
    for (const cmd of ["", "   ", "ls -la", "weird ||| thing", "((("]) {
      const segments = segmentCommand(cmd)
      if (cmd.trim() === "") {
        expect(segments).toEqual([])
      } else {
        expect(segments.length).toBeGreaterThan(0)
      }
    }
  })

  it("always includes the original line so anchored whole-command rules still fire", () => {
    const cmd = "curl x | base64 -d | sh"
    expect(segmentCommand(cmd)).toContain(cmd)
  })
})

describe("PolicyManager.evaluate denies obfuscated payloads (audit #21-25)", () => {
  const manager = new PolicyManager()

  it("#21 command substitution: ls $(rm -rf /tmp/x)", () => {
    expect(manager.evaluate("ls $(rm -rf /tmp/x)")).toBe(ExecDecision.Deny)
  })

  it('#22 eval wrapper: eval "rm -rf /"', () => {
    expect(manager.evaluate('eval "rm -rf /"')).toBe(ExecDecision.Deny)
  })

  it("#25 chained destructive: echo $HOME && rm -rf /", () => {
    expect(manager.evaluate("echo $HOME && rm -rf /")).toBe(ExecDecision.Deny)
  })

  it("keeps the pre-existing plain denials working", () => {
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("curl x | base64 -d | sh")).toBe(ExecDecision.Deny)
  })

  it("does NOT over-block ordinary commands (no false denials on safe work)", () => {
    // These must remain Ask (they are not on the deny list) — the point of the
    // fix is precision, not a blunt "deny anything with a semicolon".
    expect(manager.evaluate("ls -la")).not.toBe(ExecDecision.Deny)
    expect(manager.evaluate("git status && npm test")).not.toBe(ExecDecision.Deny)
    expect(manager.evaluate("echo hello; echo world")).not.toBe(ExecDecision.Deny)
    expect(manager.evaluate("npm run build")).not.toBe(ExecDecision.Deny)
  })
})

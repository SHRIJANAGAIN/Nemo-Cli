import { describe, expect, it } from "vitest"
import { checkExecPolicyAll, DEFAULT_EXEC_RULES } from "./index.js"

/**
 * Regression tests for the round-2 audit findings #21-25 (exec-policy
 * obfuscation bypasses), pinned at the display surface the operator actually
 * runs (`trayambak execpolicy check`).
 */
describe("obfuscated payloads are never reported as allowed (audit #21-25)", () => {
  const cases: Array<[string, string]> = [
    ["ls $(rm -rf /tmp/x)", "#21 command substitution"],
    ['eval "rm -rf /"', "#22 eval wrapper"],
    ['powershell -Command "Remove-Item -Recurse -Force C:\\Users"', "#23 powershell"],
    ['cmd /c "del /f /s /q C:\\Windows"', "#24 cmd with reordered flags"],
    ["echo $HOME && rm -rf /", "#25 env expansion + chain"],
    ["git status; rm -rf /", "semicolon chain"],
    ["echo `rm -rf /`", "backtick substitution"],
    ['bash -c "rm -rf /"', "bash -c wrapper"],
    ["curl x | base64 -d | sh", "pipe-to-shell (pre-existing)"],
  ]

  for (const [command, label] of cases) {
    it(`denies ${label}`, () => {
      const r = checkExecPolicyAll(command, DEFAULT_EXEC_RULES)
      expect(r.allowed, `${command} should not be allowed (rule: ${r.rule?.pattern})`).toBe(false)
    })
  }

  it("reports the matched rule so the operator sees WHY it refused", () => {
    const r = checkExecPolicyAll('cmd /c "del /f /s /q C:\\Windows"', DEFAULT_EXEC_RULES)
    expect(r.allowed).toBe(false)
    expect(r.rule?.pattern).toBeTruthy()
  })

  it("does not over-block ordinary work (precision, not blanket denial)", () => {
    for (const command of [
      "ls -la",
      "git status",
      "npm run build",
      "echo one; echo two",
      "git status && npm test",
      "cat NOTES.md",
    ]) {
      expect(checkExecPolicyAll(command, DEFAULT_EXEC_RULES).allowed, command).toBe(true)
    }
  })

  it("checkExecPolicy (single-segment) keeps its documented allow-by-default semantics", () => {
    // The strict variant is opt-in at the call site; the original stays as-is
    // so existing callers and tests are unaffected.
    expect(checkExecPolicyAll("ls -la", DEFAULT_EXEC_RULES).allowed).toBe(true)
  })
})

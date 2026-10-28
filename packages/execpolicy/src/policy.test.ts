/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  ExecDecision,
  NetworkRuleProtocol,
  PolicyManager,
  PolicyParser,
  createPolicyManagerForRoots,
  discoverUserPolicyFile,
  domainMatches,
  evaluatePolicy,
  getPolicyManager,
  userPolicyCandidates,
} from "./policy.js"

describe("PolicyParser", () => {
  it("parses pattern/action/reason lines and skips comments", () => {
    const policy = new PolicyParser().parse("# comment\n\nrm -rf /* deny recursive\nnpm test allow\n", "test.rules")
    expect(policy.rules).toHaveLength(2)
    expect(policy.rules[0]).toMatchObject({ pattern: "rm -rf /*", action: ExecDecision.Deny })
    expect(policy.file).toBe("test.rules")
  })

  it("rejects unknown actions as deny (fail-closed parse)", () => {
    const policy = new PolicyParser().parse("rm -rf /* bogus\n", "test.rules")
    expect(policy.rules[0]?.action).toBe(ExecDecision.Deny)
  })

  it("routes protocol-suffixed lines to network rules", () => {
    const policy = new PolicyParser().parse("*.example.com deny https\n", "test.rules")
    expect(policy.networkRules).toHaveLength(1)
    expect(policy.networkRules[0]).toMatchObject({ domain: "*.example.com", action: ExecDecision.Deny })
  })
})

describe("PolicyManager", () => {
  it("denies stock dangerous commands and asks otherwise (fail-closed default)", () => {
    const manager = new PolicyManager()
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("sudo su")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Ask)
  })

  it("deny beats allow within a policy", () => {
    const manager = new PolicyManager()
    manager.amend({
      action: "add",
      rules: [
        { pattern: "npm *", action: ExecDecision.Allow },
        { pattern: "npm publish", action: ExecDecision.Deny },
      ],
    })
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
    expect(manager.evaluate("npm publish")).toBe(ExecDecision.Deny)
  })

  it("loads a missing file as the default policy", () => {
    const manager = new PolicyManager()
    const policy = manager.load("/definitely/not/here.rules")
    expect(policy.file).toBe("(default)")
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
  })

  it("loads and round-trips a policy file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-execpolicy-"))
    try {
      const file = path.join(dir, "test.rules")
      fs.writeFileSync(file, "npm * allow\n", "utf8")
      const manager = new PolicyManager()
      manager.load(file)
      expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("evaluates network rules by host or subdomain (not substring)", () => {
    const manager = new PolicyManager()
    manager.amend({
      action: "add",
      networkRules: [{ domain: "evil.example", action: ExecDecision.Deny, protocol: NetworkRuleProtocol.All }],
    })
    expect(manager.evaluateNetwork("evil.example")).toBe(ExecDecision.Deny)
    expect(manager.evaluateNetwork("good.example")).toBe(ExecDecision.Ask)
  })
})

describe("domainMatches", () => {
  it("matches exact hosts and real subdomains only", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true)
    expect(domainMatches("evil.example.com", "example.com")).toBe(true)
    expect(domainMatches("sub.example.com", "example.com")).toBe(true)
    // The audit's two substring false-positives: neither is a subdomain.
    expect(domainMatches("notexample.com", "example.com")).toBe(false)
    expect(domainMatches("example.com.evil.net", "example.com")).toBe(false)
    expect(domainMatches("anything", "")).toBe(false)
  })
  it("normalises wildcard, port, case, and trailing-dot spellings", () => {
    expect(domainMatches("example.com", "*.example.com")).toBe(true)
    expect(domainMatches("api.example.com", "*.example.com")).toBe(true)
    expect(domainMatches("example.com:443", "example.com")).toBe(true)
    expect(domainMatches("EXAMPLE.com:8443", "example.com")).toBe(true)
    expect(domainMatches("example.com.", "example.com")).toBe(true)
    expect(domainMatches("notexample.com", "*.example.com")).toBe(false)
  })
  it("falls back to Ask when no rule matches", () => {
    const manager = new PolicyManager()
    manager.amend({
      action: "add",
      networkRules: [{ domain: "example.com", action: ExecDecision.Deny, protocol: NetworkRuleProtocol.All }],
    })
    expect(manager.evaluateNetwork("api.example.com")).toBe(ExecDecision.Deny)
    expect(manager.evaluateNetwork("notexample.com")).toBe(ExecDecision.Ask)
    expect(manager.evaluateNetwork("example.com.evil.net")).toBe(ExecDecision.Ask)
  })
})

// Temporary .rules trees for discovery/merge tests. Roots are tracked so
// afterEach can remove them even when a test fails midway.
let tempRoots: string[] = []
const mkRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-rules-"))
  tempRoots.push(root)
  return root
}
const writeRules = (root: string, body: string): string => {
  const dir = path.join(root, ".nemo")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "policy.rules")
  fs.writeFileSync(file, body, "utf8")
  return file
}

describe("user .rules discovery", () => {
  beforeEach(() => {
    tempRoots = []
  })
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("lists the project copy before the home copy", () => {
    expect(userPolicyCandidates("P", "H")).toEqual([
      path.join("P", ".nemo", "policy.rules"),
      path.join("H", ".nemo", "policy.rules"),
    ])
    expect(userPolicyCandidates("", "H")).toEqual([path.join("H", ".nemo", "policy.rules")])
    expect(userPolicyCandidates("P", "")).toEqual([path.join("P", ".nemo", "policy.rules")])
  })

  it("prefers <cwd>/.nemo/policy.rules over the home copy", () => {
    const project = mkRoot()
    const home = mkRoot()
    const projectFile = writeRules(project, "npm * allow\n")
    writeRules(home, "git * allow\n")
    expect(discoverUserPolicyFile(project, home)).toBe(projectFile)
  })

  it("falls back to ~/.nemo/policy.rules when the project has none", () => {
    const home = mkRoot()
    const homeFile = writeRules(home, "npm * allow\n")
    expect(discoverUserPolicyFile(mkRoot(), home)).toBe(homeFile)
  })

  it("finds nothing when neither root carries a file", () => {
    expect(discoverUserPolicyFile(mkRoot(), mkRoot())).toBeNull()
  })

  it("loads the discovered project file merged over the defaults", () => {
    const project = mkRoot()
    const home = mkRoot()
    writeRules(project, "npm * allow\n")
    writeRules(home, "git * allow\n") // must lose: project copy wins
    const manager = createPolicyManagerForRoots(project, home)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
    expect(manager.evaluate("git status")).toBe(ExecDecision.Ask) // home copy not loaded
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny) // defaults survive
  })

  it("loads the home copy when the project has none", () => {
    const home = mkRoot()
    writeRules(home, "npm * allow\n")
    const manager = createPolicyManagerForRoots(mkRoot(), home)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
    expect(manager.evaluate("sudo su")).toBe(ExecDecision.Deny) // default deny survives
  })

  it("keeps the pure default policy when no file exists", () => {
    const manager = createPolicyManagerForRoots(mkRoot(), mkRoot())
    expect(manager.getPolicy().file).toBe("(default)")
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Ask)
  })
})

describe("loadUserPolicy (user file merged over defaults)", () => {
  let dir = ""
  let file = ""

  beforeEach(() => {
    dir = mkRoot()
    file = path.join(dir, "policy.rules")
  })
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("lets a user file add rules but never remove a default deny", () => {
    fs.writeFileSync(file, "sudo * allow\nnpm * allow\n", "utf8")
    const manager = new PolicyManager()
    const policy = manager.loadUserPolicy(file)
    expect(policy.rules).toHaveLength(new PolicyManager().getPolicy().rules.length + 2) // defaults + 2 user lines
    expect(policy.file).toBe(file)
    // Deny pass runs before the allow pass, so the default `sudo *` deny
    // beats the user's `sudo * allow`: a file can widen, never un-deny.
    expect(manager.evaluate("sudo su")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
  })

  it("merges user network rules onto the (empty) default list", () => {
    fs.writeFileSync(file, "*.example.com deny https\n", "utf8")
    const manager = new PolicyManager()
    manager.loadUserPolicy(file)
    expect(manager.evaluateNetwork("api.example.com")).toBe(ExecDecision.Deny)
    expect(manager.evaluateNetwork("other.net")).toBe(ExecDecision.Ask)
  })

  it("falls back to the defaults when the file cannot be read", () => {
    const manager = new PolicyManager()
    // A directory where a file is expected: readFileSync throws (EISDIR).
    const policy = manager.loadUserPolicy(dir)
    expect(policy.file).toBe("(default)")
    expect(manager.getPolicy().rules).toHaveLength(new PolicyManager().getPolicy().rules.length)
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
  })

  it("hot-reloads the merged view and fails closed on garbage", () => {
    fs.writeFileSync(file, "npm * allow\n", "utf8")
    const manager = new PolicyManager()
    manager.loadUserPolicy(file)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)

    // reload() is exactly what the fs.watch callback calls: an edit that
    // leaves a line without an action keyword parses as a DENY rule for
    // that pattern (parseLine fails closed), and the defaults are still
    // merged in after the reload.
    fs.writeFileSync(file, "npm test\n", "utf8")
    manager.reload(file)
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Deny)
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Deny)
  })

  it("keeps load() semantics: the file replaces, it does not merge", () => {
    fs.writeFileSync(file, "npm * allow\n", "utf8")
    const manager = new PolicyManager()
    manager.load(file)
    expect(manager.getPolicy().rules).toHaveLength(1) // defaults NOT merged in
    expect(manager.evaluate("npm test")).toBe(ExecDecision.Allow)
    expect(manager.evaluate("rm -rf /")).toBe(ExecDecision.Ask) // load() has always been file-only
    manager.reload(file) // replace mode reloads as replace
    expect(manager.getPolicy().rules).toHaveLength(1)
  })
})

describe("evaluatePolicy", () => {
  it("uses the default manager", () => {
    expect(evaluatePolicy("rm -rf /")).toBe(ExecDecision.Deny)
    expect(evaluatePolicy("npm test")).toBe(ExecDecision.Ask)
    expect(getPolicyManager()).toBe(getPolicyManager())
  })
})

describe("obfuscation bypasses (round-2 findings #21-25)", () => {
  const deny = (cmd: string): void => {
    expect(new PolicyManager().evaluate(cmd), cmd).toBe(ExecDecision.Deny)
  }

  it("denies payloads hidden in command substitution and backticks", () => {
    deny("ls $(rm -rf /tmp/x)")
    deny("echo `rm -rf /`")
  })

  it("denies eval/sh -c wrappers around destructive payloads", () => {
    deny('eval "rm -rf /"')
    deny('sh -c "rm -rf /"')
    deny('sudo bash -c "rm -rf /"')
  })

  it("denies chained destructive segments", () => {
    deny("echo $HOME && rm -rf /")
    deny("echo hi; rm -rf /tmp/x")
  })

  it("denies Windows destructive verbs at parity with rm -rf", () => {
    deny('powershell -Command "Remove-Item -Recurse -Force C:\\Users"')
    deny('cmd /c "del /f /s /q C:\\Windows"')
    deny("del /s /q C:\\Windows")
    deny("Remove-Item -Recurse -Force C:\\Users")
    deny("rd /s /q C:\\temp")
    deny("rmdir /s C:\\temp")
  })

  it("still asks for benign wrappers and single-file deletes", () => {
    const manager = new PolicyManager()
    expect(manager.evaluate("echo hello")).toBe(ExecDecision.Ask)
    expect(manager.evaluate("del notes.txt")).toBe(ExecDecision.Ask)
  })
})

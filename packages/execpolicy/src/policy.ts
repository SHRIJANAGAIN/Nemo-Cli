/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Exec policy engine — .rules file parsing and evaluation.
 *
 * Mirrors codex-execpolicy in Rust.
 * Supports .rules files with hot-reload capability.
 */

import { readFileSync, watch, existsSync } from "fs"
import * as os from "os"
import * as path from "path"
import { segmentCommand } from "./segments.js"

/** Network protocol types for rules. */
export enum NetworkRuleProtocol {
  Http = "http",
  Https = "https",
  All = "all",
}

/** Exec policy decision. */
export enum ExecDecision {
  Allow = "allow",
  Deny = "deny",
  Ask = "ask",
}

/** A single exec policy rule. */
export interface ExecPolicyRule {
  pattern: string
  action: ExecDecision
  reason?: string
  networkProtocol?: NetworkRuleProtocol
}

/** A network rule within exec policy. */
export interface NetworkRule {
  domain: string
  action: ExecDecision
  protocol: NetworkRuleProtocol
}

/** Parsed exec policy. */
export interface ExecPolicy {
  rules: ExecPolicyRule[]
  networkRules: NetworkRule[]
  file: string
  lastModified: number
}

/** Amendment to an existing policy. */
export interface ExecPolicyAmendment {
  action: "add" | "remove" | "update"
  rules?: ExecPolicyRule[]
  networkRules?: NetworkRule[]
}

/**
 * Policy parser — parses .rules files.
 */
export class PolicyParser {
  /**
   * Parse a .rules file string into an ExecPolicy.
   */
  parse(raw: string, file: string): ExecPolicy {
    const rules: ExecPolicyRule[] = []
    const networkRules: NetworkRule[] = []
    const lines = raw.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue

      const rule = this.parseLine(trimmed)
      if (rule) {
        if (rule.networkProtocol) {
          networkRules.push({
            domain: rule.pattern,
            action: rule.action,
            protocol: rule.networkProtocol,
          })
        } else {
          rules.push(rule)
        }
      }
    }

    return {
      rules,
      networkRules,
      file,
      lastModified: Date.now(),
    }
  }

  private parseLine(line: string): ExecPolicyRule | null {
    // Format: "<pattern…> <action> [reason…] [protocol]"
    // The pattern itself may contain spaces ("rm -rf /* deny"), so the
    // action is the FIRST token naming one (allow/deny/ask) — everything
    // before it is the pattern. The old first-two-tokens split turned
    // "rm -rf /* deny" into pattern "rm", silently changing matches.
    // Examples: "rm -rf /* deny" "*.example.com deny https"
    const parts = line.split(/\s+/)
    if (parts.length < 2) return null
    const isAction = (t: string): boolean =>
      [ExecDecision.Allow, ExecDecision.Deny, ExecDecision.Ask].includes(t as ExecDecision)
    const actionIdx = parts.findIndex((p) => isAction(p))
    // No action keyword at all: whole line is the pattern, fail-closed deny
    // ("foo bogus" denies "foo bogus" rather than allowing by confusion).
    const patternParts = actionIdx === -1 ? parts : parts.slice(0, actionIdx)
    const action: ExecDecision = actionIdx === -1 ? ExecDecision.Deny : (parts[actionIdx] as ExecDecision)
    const after = actionIdx === -1 ? [] : parts.slice(actionIdx + 1)
    const protocol = after.find((p) => ["http", "https", "all"].includes(p)) as NetworkRuleProtocol | undefined
    const pattern = patternParts.join(" ")
    if (!pattern) return null
    const reason = after.find((p) => p !== protocol && !p.startsWith("http://") && !p.startsWith("https://"))
    return {
      pattern,
      action,
      reason,
      networkProtocol: protocol,
    }
  }
}

/**
 * Separator-aware domain match: exact host or a real subdomain.
 * Substring matching would let `example.com` also match
 * `notexample.com` and `example.com.evil.net`.
 */
export function domainMatches(host: string, entry: string): boolean {
  const norm = (v: string): string => {
    let s = v.trim().toLowerCase()
    const parts = s.split(":")
    if (parts.length === 2 && /^\d+$/.test(parts[1])) s = parts[0]
    return s.replace(/^\*\.+/, "").replace(/\.$/, "")
  }
  const h = norm(host)
  const e = norm(entry)
  if (!e) return false
  return h === e || h.endsWith(`.${e}`)
}

/**
 * Policy manager — loads, evaluates, and hot-reloads policies.
 */
export class PolicyManager {
  private policy: ExecPolicy | null = null
  private watchers: Map<string, ReturnType<typeof watch>> = new Map()
  private readonly parser = new PolicyParser()
  /**
   * How the current policy was loaded. `replace` = the file IS the policy
   * (`load`); `merge` = the file sits ON TOP of the defaults
   * (`loadUserPolicy`). A hot reload must replay the same shape it was
   * loaded with, or a user file would silently drop the default denies on
   * the next write.
   */
  private mode: "replace" | "merge" = "replace"

  /**
   * Load policy from a .rules file (the file REPLACES the policy; this is
   * the original semantics, kept for existing callers and tests).
   */
  load(file: string): ExecPolicy {
    if (!existsSync(file)) {
      return this.getDefaultPolicy()
    }
    const raw = readFileSync(file, "utf8")
    this.policy = this.parser.parse(raw, file)
    this.mode = "replace"
    this.watch(file)
    return this.policy
  }

  /**
   * Load a user `.rules` file MERGED OVER the built-in defaults.
   *
   * The file can only ADD rules: `rules = [...defaultPolicy.rules,
   * ...fileRules]` (networkRules too). `evaluate` runs its deny pass over
   * every rule before its allow pass, so a file line `sudo * allow` still
   * loses to the default `sudo *` deny - a user file can widen what is
   * allowed but can never silently delete a default deny.
   *
   * Missing or unreadable file (deleted between stat and read, EISDIR,
   * EPERM): fall back to the defaults, which carry the denies, rather
   * than keeping anything a half-written file produced. Fail closed.
   */
  loadUserPolicy(file: string): ExecPolicy {
    const defaults = this.getDefaultPolicy()
    let raw: string | null = null
    try {
      if (existsSync(file)) raw = readFileSync(file, "utf8")
    } catch {
      raw = null
    }
    if (raw === null) {
      this.policy = defaults
      return defaults
    }
    const filePolicy = this.parser.parse(raw, file)
    const merged: ExecPolicy = {
      rules: [...defaults.rules, ...filePolicy.rules],
      networkRules: [...defaults.networkRules, ...filePolicy.networkRules],
      file: filePolicy.file,
      lastModified: filePolicy.lastModified,
    }
    this.policy = merged
    this.mode = "merge"
    this.watch(file)
    return merged
  }

  /**
   * Get the current policy (falls back to defaults).
   */
  getPolicy(): ExecPolicy {
    if (!this.policy) {
      return this.getDefaultPolicy()
    }
    return this.policy
  }

  /**
   * Evaluate a command against the policy.
   *
   * The whole line AND every sub-command it will execute are evaluated, and the
   * strictest verdict wins (Deny > Ask > Allow). Evaluating only the outer
   * string was the bypass: `ls $(rm -rf /tmp/x)` and `eval "rm -rf /"` matched
   * no deny rule, so the hidden payload reached the user as a bare "ask" on a
   * harmless-looking wrapper and ran unchecked once approved.
   */
  evaluate(command: string): ExecDecision {
    const policy = this.getPolicy()
    const segments = segmentCommand(command)

    // Strictest-wins accumulation, seeded at Allow so an all-Allow policy
    // still returns Allow (seeding at Ask would mask it).
    let worst: ExecDecision = ExecDecision.Allow
    for (const segment of segments) {
      const verdict = this.evaluateSingle(segment, policy)
      if (verdict === ExecDecision.Deny) return ExecDecision.Deny
      if (verdict === ExecDecision.Ask) worst = ExecDecision.Ask
    }
    return worst
  }

  /** Single-pass verdict for one already-split segment. */
  private evaluateSingle(command: string, policy: ExecPolicy): ExecDecision {
    // Check deny rules first (hard veto)
    for (const rule of policy.rules) {
      if (this.matchPattern(rule.pattern, command) && rule.action === ExecDecision.Deny) {
        return ExecDecision.Deny
      }
    }

    // Check allow rules
    for (const rule of policy.rules) {
      if (this.matchPattern(rule.pattern, command) && rule.action === ExecDecision.Allow) {
        return ExecDecision.Allow
      }
    }

    // Default: ask
    return ExecDecision.Ask
  }

  /**
   * Evaluate a network request against the policy.
   */
  evaluateNetwork(domain: string): ExecDecision {
    const policy = this.getPolicy()

    for (const rule of policy.networkRules) {
      if (domainMatches(domain, rule.domain)) {
        return rule.action
      }
    }
    return ExecDecision.Ask
  }

  /**
   * Apply a policy amendment.
   */
  amend(amendment: ExecPolicyAmendment): void {
    const policy = this.policy ?? this.getDefaultPolicy()
    if (amendment.rules) {
      for (const rule of amendment.rules) {
        if (amendment.action === "add") {
          policy.rules.push(rule)
        } else if (amendment.action === "remove") {
          const idx = policy.rules.findIndex((r) => r.pattern === rule.pattern)
          if (idx >= 0) policy.rules.splice(idx, 1)
        }
      }
    }
    if (amendment.networkRules) {
      for (const rule of amendment.networkRules) {
        if (amendment.action === "add") {
          policy.networkRules.push(rule)
        }
      }
    }
    this.policy = policy
    policy.lastModified = Date.now()
    this.watch(policy.file)
  }

  /**
   * Hot-reload a policy file. Replays the load shape it was loaded with:
   * `merge` policies re-merge over the defaults (so a hot reload can never
   * drop a default deny), `replace` policies re-read the file as before.
   */
  reload(file: string): void {
    if (this.mode === "merge") {
      this.loadUserPolicy(file)
    } else {
      this.load(file)
    }
  }

  /**
   * Start watching a file for changes.
   */
  private watch(file: string): void {
    try {
      const watcher = watch(file, () => {
        this.reload(file)
      })
      // Async watcher failures (EPERM on locked/Windows temp files) emit
      // 'error' — without a listener they crash the process.
      watcher.on("error", () => {
        try {
          watcher.close()
        } catch {
          /* already dead */
        }
        this.watchers.delete(file)
      })
      this.watchers.set(file, watcher)
    } catch {
      /* ignore watch errors */
    }
  }

  /**
   * Get the default policy (hardcoded deny rules).
   */
  private getDefaultPolicy(): ExecPolicy {
    return {
      rules: [
        { pattern: "rm -rf /*", action: ExecDecision.Deny, reason: "recursive force delete" },
        { pattern: "rm -rf ~*", action: ExecDecision.Deny, reason: "recursive force delete" },
        { pattern: "format *", action: ExecDecision.Deny, reason: "disk format" },
        { pattern: "shutdown *", action: ExecDecision.Deny, reason: "system power" },
        { pattern: "sudo *", action: ExecDecision.Deny, reason: "privilege escalation" },
        { pattern: "mkfs*", action: ExecDecision.Deny, reason: "filesystem format" },
        { pattern: "dd *of=*", action: ExecDecision.Deny, reason: "raw disk write" },
        { pattern: "reg delete *", action: ExecDecision.Deny, reason: "Windows registry delete" },
        { pattern: "* | sh", action: ExecDecision.Deny, reason: "pipe-to-shell download" },
        { pattern: "* | bash", action: ExecDecision.Deny, reason: "pipe-to-shell download" },
      ],
      networkRules: [],
      file: "(default)",
      lastModified: Date.now(),
    }
  }

  /**
   * Match a glob pattern against a string.
   */
  private matchPattern(pattern: string, command: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${escaped}$`, "i").test(command)
  }
}

// Singleton instance
let defaultManager: PolicyManager | null = null

/**
 * Get the default PolicyManager singleton. On FIRST construction it
 * discovers a user-authored rules file (`<cwd>/.trayambak/policy.rules`,
 * then `~/.trayambak/policy.rules`) and loads it MERGED over the
 * defaults - previously nothing ever called `load()`, so the whole DSL
 * was dead config. No file (or an unreadable one) keeps the hardcoded
 * default policy, default denies included.
 */
export function getPolicyManager(): PolicyManager {
  if (!defaultManager) {
    defaultManager = createPolicyManagerForRoots(
      resolveRoot(() => process.cwd()),
      resolveRoot(() => os.homedir()),
    )
  }
  return defaultManager
}

/**
 * The two places a user rules file may live, most specific first: the
 * project copy, then the user's home copy. Empty roots are skipped (no
 * cwd, or no home directory available).
 */
export function userPolicyCandidates(cwd: string, home: string): string[] {
  const files: string[] = []
  if (cwd) files.push(path.join(cwd, ".trayambak", "policy.rules"))
  if (home) files.push(path.join(home, ".trayambak", "policy.rules"))
  return files
}

/**
 * First existing candidate in project-then-home order, or null when
 * neither location has a file. Exported so tests can prove the discovery
 * order without touching the real home directory.
 */
export function discoverUserPolicyFile(cwd: string, home: string): string | null {
  for (const file of userPolicyCandidates(cwd, home)) {
    try {
      if (existsSync(file)) return file
    } catch {
      /* unreadable candidate: keep looking, fall back to defaults */
    }
  }
  return null
}

/**
 * The manager `getPolicyManager()` builds for explicit roots: discover a
 * user rules file, and when one exists load it MERGED over the defaults
 * (so a user file can add rules but can never drop a default deny).
 * Exposed so tests can exercise discovery without mutating the process
 * cwd or the user's real home directory.
 */
export function createPolicyManagerForRoots(cwd: string, home: string): PolicyManager {
  const manager = new PolicyManager()
  const file = discoverUserPolicyFile(cwd, home)
  if (file) manager.loadUserPolicy(file)
  return manager
}

/** Resolve a filesystem root, or "" when the OS refuses (deleted cwd, no home). */
function resolveRoot(f: () => string): string {
  try {
    return f()
  } catch {
    return ""
  }
}

/**
 * Evaluate a command using the default policy manager.
 */
export function evaluatePolicy(command: string): ExecDecision {
  return getPolicyManager().evaluate(command)
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Exec policy engine — .rules file parsing and evaluation.
 *
 * Mirrors codex-execpolicy in Rust.
 * Supports .rules files with hot-reload capability.
 */

import { readFileSync, watch, existsSync } from "fs"

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
    // Format: "pattern action [reason] [protocol]"
    // Examples: "rm -rf /* deny" "*.example.com deny https"
    const parts = line.split(/\s+/)
    if (parts.length < 2) return null

    const pattern = parts[0]
    const action = parts[1] as ExecDecision
    const reason = parts.slice(2).find((p) => !p.startsWith("http://") && !p.startsWith("https://")) || undefined
    const protocol = parts.find((p) => ["http", "https", "all"].includes(p)) as NetworkRuleProtocol | undefined

    return {
      pattern,
      action: [ExecDecision.Allow, ExecDecision.Deny, ExecDecision.Ask].includes(action) ? action : ExecDecision.Deny,
      reason,
      networkProtocol: protocol,
    }
  }
}

/**
 * Policy manager — loads, evaluates, and hot-reloads policies.
 */
export class PolicyManager {
  private policy: ExecPolicy | null = null
  private watchers: Map<string, ReturnType<typeof watch>> = new Map()
  private readonly parser = new PolicyParser()

  /**
   * Load policy from a .rules file.
   */
  load(file: string): ExecPolicy {
    if (!existsSync(file)) {
      return this.getDefaultPolicy()
    }
    const raw = readFileSync(file, "utf8")
    this.policy = this.parser.parse(raw, file)
    this.watch(file)
    return this.policy
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
   */
  evaluate(command: string): ExecDecision {
    const policy = this.getPolicy()

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
      if (domain.includes(rule.domain)) {
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
   * Hot-reload a policy file.
   */
  reload(file: string): void {
    this.load(file)
  }

  /**
   * Start watching a file for changes.
   */
  private watch(file: string): void {
    try {
      const watcher = watch(file, () => {
        this.load(file)
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
 * Get the default PolicyManager singleton.
 */
export function getPolicyManager(): PolicyManager {
  if (!defaultManager) {
    defaultManager = new PolicyManager()
  }
  return defaultManager
}

/**
 * Evaluate a command using the default policy manager.
 */
export function evaluatePolicy(command: string): ExecDecision {
  return getPolicyManager().evaluate(command)
}

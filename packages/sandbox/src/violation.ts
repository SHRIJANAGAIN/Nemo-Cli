/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Violation detection and recording for sandboxed processes.
 *
 * Mirrors codex-sandboxing/src/violation.rs in Rust.
 * Records filesystem and network violations when they occur
 * inside an OS-level sandbox.
 */

import { appendFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, resolve, sep } from "path"

import { SandboxViolation } from "./types.js"

/**
 * Violation log file path.
 */
const VIOLATION_LOG_PATH = join(homedir(), ".nemo", "violations.jsonl")

/**
 * Record a filesystem sandbox violation.
 */
export function recordFilesystemViolation(violationPath: string, operation: string, pid: number): void {
  const violation: SandboxViolation = {
    type: "filesystem",
    path: violationPath,
    operation,
    timestamp: Date.now(),
    pid,
  }
  writeViolation(violation)
}

/**
 * Record a network sandbox violation.
 */
export function recordNetworkViolation(domain: string, operation: string, pid: number): void {
  const violation: SandboxViolation = {
    type: "network",
    domain,
    operation,
    timestamp: Date.now(),
    pid,
  }
  writeViolation(violation)
}

/**
 * True when `target` is `root` itself or a descendant of it.
 *
 * A bare `startsWith` on resolved paths is not a containment test: it treats
 * `/workspace-evil` as living inside `/workspace`. The separator must be part
 * of the prefix so only whole path segments match.
 */
function isInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  if (resolvedTarget === resolvedRoot) return true
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep
  return resolvedTarget.startsWith(prefix)
}

/**
 * Check if a filesystem access would violate the sandbox policy.
 */
export function isFilesystemViolation(
  filePath: string,
  writableRoots: string[],
  denyReadPaths: string[],
  denyWritePaths: string[],
): boolean {
  const resolved = resolve(filePath)

  // Check deny-read
  for (const denyPath of denyReadPaths) {
    if (isInside(denyPath, resolved)) {
      return true
    }
  }
  // Check deny-write
  for (const denyPath of denyWritePaths) {
    if (isInside(denyPath, resolved)) {
      return true
    }
  }
  // Check writable roots
  const isWritable = writableRoots.some((root) => isInside(root, resolved))
  if (!isWritable) {
    return true
  }

  return false
}

/**
 * Fold a hostname for comparison: lowercased, port dropped, leading wildcard
 * and trailing dot stripped.
 */
function normalizeDomain(value: string): string {
  let v = value.trim().toLowerCase()
  const parts = v.split(":")
  if (parts.length === 2 && /^\d+$/.test(parts[1])) v = parts[0]
  return v.replace(/^\*\.+/, "").replace(/\.$/, "")
}

/**
 * True when `host` is `entry` itself or a subdomain of it.
 *
 * Substring matching is not equivalent: an `example.com` entry would also
 * admit `example.com.evil.net` and `notexample.com`, so an allow list built
 * that way authorises far more than it looks like.
 */
function domainMatches(host: string, entry: string): boolean {
  const normalizedHost = normalizeDomain(host)
  const normalizedEntry = normalizeDomain(entry)
  if (!normalizedEntry) return false
  return normalizedHost === normalizedEntry || normalizedHost.endsWith("." + normalizedEntry)
}

/**
 * Check if a network request would violate the sandbox policy.
 */
export function isNetworkViolation(
  domain: string,
  allowedDomains: string[],
  blockedDomains: string[],
  disableNetwork: boolean,
): boolean {
  if (disableNetwork) return true
  // Deny list wins over allow list.
  if (blockedDomains.some((d) => domainMatches(domain, d))) return true
  if (allowedDomains.length > 0 && !allowedDomains.some((d) => domainMatches(domain, d))) return true
  return false
}

/**
 * Check if a command is likely to be denied by the sandbox executor.
 */
export function isLikelySandboxDenied(command: string): boolean {
  const denyPatterns = [
    /rm\s+-rf\s+\//,
    /format\s+/,
    /shutdown\s+/,
    /sudo\s+/,
    /mkfs\s+/,
    /dd\s+.*of=/,
    /reg\s+delete\s+/,
    /vssadmin\s+/,
    /\|\s*sh\s*$/,
    /\|\s*bash\s*$/,
  ]
  return denyPatterns.some((p) => p.test(command))
}

/**
 * Write violation to the JSONL log file.
 */
function writeViolation(violation: SandboxViolation): void {
  try {
    mkdirSync(join(homedir(), ".nemo"), { recursive: true })
    appendFileSync(VIOLATION_LOG_PATH, JSON.stringify(violation) + "\n", "utf8")
  } catch {
    /* best effort — never let logging break the CLI */
  }
}

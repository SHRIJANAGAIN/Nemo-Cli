/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Violation detection and recording for sandboxed processes.
 *
 * Mirrors codex-sandboxing/src/violation.rs in Rust.
 * Records filesystem and network violations when they occur
 * inside an OS-level sandbox.
 */

import { appendFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"

import { SandboxViolation } from "./types.js"

/**
 * Violation log file path.
 */
const VIOLATION_LOG_PATH = join(homedir(), ".trayambak", "violations.jsonl")

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
    if (resolved.startsWith(resolve(denyPath))) {
      return true
    }
  }
  // Check deny-write
  for (const denyPath of denyWritePaths) {
    if (resolved.startsWith(resolve(denyPath))) {
      return true
    }
  }
  // Check writable roots
  const isWritable = writableRoots.some((root) => resolved.startsWith(resolve(root)))
  if (!isWritable) {
    return true
  }

  return false
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
  if (blockedDomains.some((d) => domain.includes(d))) return true
  if (allowedDomains.length > 0 && !allowedDomains.some((d) => domain.includes(d))) return true
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
    mkdirSync(join(homedir(), ".trayambak"), { recursive: true })
    appendFileSync(VIOLATION_LOG_PATH, JSON.stringify(violation) + "\n", "utf8")
  } catch {
    /* best effort — never let logging break the CLI */
  }
}

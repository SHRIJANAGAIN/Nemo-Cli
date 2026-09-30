/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/** Cross-process best-effort file lock (mkdir-based, portable). */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lockDir = `${file}.lock`
  const deadline = Date.now() + 5000
  while (true) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch {
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {
      /* best effort */
    }
  }
}

const SECRET_KEYS = ["apiKey", "api_key", "apikey", "token", "secret", "authorization"]

/**
 * Token COUNTER keys — the only shapes exempt from the "token" substring rule.
 *
 * `maxTokens`, `inputTokens`, `tokensBefore`, `tokenCount`, `max_tokens` all
 * contain "token", so substring matching masked them as `"****"`: analytics
 * aggregates went NaN and hooks received `maxTokens: "****"` instead of a
 * budget. They are numbers, and a number is not key material.
 *
 * Deliberately narrow: a modifier from a fixed vocabulary, or "tokens" plus a
 * fixed counter suffix. A bare `token`/`tokens` key does NOT match — that is
 * the single most credential-shaped name in the set — and `githubToken`,
 * `apiToken`, `accessToken`, `refreshToken`, `idToken` all stay masked.
 */
const TOKEN_COUNTER =
  /^(?:(?:max|min|total|input|output|prompt|completion|cached|context|estimated|remaining|reserved|available|window|used)[-_]?tokens?|tokens?[-_]?(?:count|used|before|after|total|remaining|limit|budget|in|out|per[-_]?request))$/i

/** True when a config/env key name holds secret material. */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (!SECRET_KEYS.some((s) => lower.includes(s))) return false
  // A counter is only exempt when "token" is the ONLY secret-ish marker on the
  // key: "maxTokenSecret" carries "secret" too and must stay masked.
  if (
    lower.includes("secret") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("authorization")
  ) {
    return true
  }
  return !TOKEN_COUNTER.test(lower)
}

const EMBEDDED_KEY_PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bhf_[A-Za-z0-9]+\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{10,}\b/g,
  // GitHub token shapes: CREDENTIAL_PREFIX already masks them at the head of
  // a string, so mid-string copies (pasted into prose, a curl command, a hook
  // payload) must not be the one hole in the pattern set.
  /\bghp_[A-Za-z0-9_]{10,}/g,
  /\bgho_[A-Za-z0-9_]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~-]+/gi,
]

/**
 * Mask key material embedded in prose (URLs, pasted tokens, headers)
 * while leaving the surrounding text intact. Unlike redactSecrets (for
 * known-secret values), this never truncates ordinary sentences.
 */
export function redactEmbeddedSecrets(text: string): string {
  let out = text
  for (const pattern of EMBEDDED_KEY_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "[REDACTED]")
  }
  return out
}

/** Credential-shaped string prefixes (provider keys, bearer tokens, KEY=…). */
const CREDENTIAL_PREFIX = /^(nvapi-|sk-|hf_|xai-|AIza|Bearer\s+|Basic\s+|ghp_|gho_|github_pat_)/i

/** Deep-redact secrets for logs/diagnostics. Never prints key material. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(nvapi-|sk-|hf_|xai-|AIza)/.test(value.trim()) || value.length > 24) {
      return value.slice(0, 4) + "****"
    }
    return value
  }
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // One decision point for "is this key secret" — same rule (and the same
      // token-counter exemptions) as the payload redactor below.
      out[k] = isSecretKey(k) ? "****" : redactSecrets(v)
    }
    return out
  }
  return value
}

/**
 * Free-text-safe redaction for the CLI logger.
 *
 * `redactSecrets` truncates any string longer than 24 chars, which is right
 * for credential objects and wrong for log lines (it would turn every file
 * path and stack trace into `"abcd****"`). This variant masks only what is
 * actually credential-shaped: secret-named keys, and strings that begin like
 * a provider key or bearer token — while leaving ordinary prose intact.
 */
export function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return CREDENTIAL_PREFIX.test(trimmed) ? trimmed.slice(0, 4) + "****" : value
  }
  if (Array.isArray(value)) return value.map(redactLogValue)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "****" : redactLogValue(v)
    }
    return out
  }
  return value
}

/**
 * Payload-safe deep redactor for hook payloads, analytics buffers, and
 * telemetry output — the "secrets are redacted before hooks/audit/analytics/
 * telemetry" boundary.
 *
 * Why this exists: `redactSecrets` truncates ANY string longer than 24 chars,
 * which is right for a credential object and catastrophic for a payload (it
 * would shred every file path and every ordinary sentence). `redactPayload`
 * never truncates ordinary prose. It:
 *
 *   (a) masks secret-named keys (`apiKey`, `token`, `secret`, …) with `"****"`,
 *   (b) runs strings through `redactEmbeddedSecrets` (mid-string `sk-…`,
 *       `ghp_…`, `Bearer …`, … → `[REDACTED]`) and then the credential-prefix
 *       mask (4-char head + `"****"`) for strings that START like a key,
 *   (c) recurses arrays and plain objects (and stops at a circular reference
 *       with `"[Circular]"` instead of overflowing the stack),
 *   (d) passes numbers, booleans, null, and — critically — long ordinary
 *       strings through byte-for-byte.
 *
 * The ONLY strings this rewrites are credential-shaped; a 200-char Windows
 * path, a shell command, or a paragraph of prose comes back identical.
 */
export function redactPayload(value: unknown): unknown {
  return redactPayloadInner(value, new WeakSet<object>())
}

/** Inner recursion for {@link redactPayload}. `ancestors` holds the current
 *  path only (entries are removed again after their subtree is walked), so a
 *  shared reference is walked normally while a true cycle stops at
 *  `"[Circular]"` instead of overflowing the stack. */
function redactPayloadInner(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    const embedded = redactEmbeddedSecrets(value)
    const trimmed = embedded.trim()
    return CREDENTIAL_PREFIX.test(trimmed) ? embedded.slice(0, 4) + "****" : embedded
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return "[Circular]"
    ancestors.add(value)
    try {
      return value.map((entry) => redactPayloadInner(entry, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) return "[Circular]"
    ancestors.add(value)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSecretKey(k) ? "****" : redactPayloadInner(v, ancestors)
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }
  return value
}

export function secureDir(dir?: string): string {
  const d = dir ?? path.join(os.homedir(), ".trayambak")
  fs.mkdirSync(d, { recursive: true })
  try {
    fs.chmodSync(d, 0o700)
  } catch {
    /* Windows */
  }
  return d
}

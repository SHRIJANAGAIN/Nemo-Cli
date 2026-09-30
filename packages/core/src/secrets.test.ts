import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import {
  isSecretKey,
  redactEmbeddedSecrets,
  redactLogValue,
  redactPayload,
  redactSecrets,
  secureDir,
  withFileLock,
} from "./secrets.js"

/**
 * The "token" substring rule, and the one exemption. Counters are numbers, not
 * key material — masking them turned analytics aggregates into NaN and handed
 * hooks `maxTokens: "****"`. Everything that could plausibly hold a credential
 * must still mask, so both directions are pinned here.
 */
describe("isSecretKey", () => {
  it("treats token COUNTER keys as non-secret", () => {
    for (const key of [
      "maxTokens",
      "minTokens",
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "cachedTokens",
      "contextTokens",
      "tokensBefore",
      "tokensAfter",
      "tokenCount",
      "tokensUsed",
      "tokensRemaining",
      "tokensLimit",
      "max_tokens",
      "MAX_TOKENS",
      "input-tokens",
    ]) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })

  it("still masks every credential-shaped name, bare `token` included", () => {
    for (const key of [
      "token",
      "tokens",
      "apiToken",
      "githubToken",
      "hfToken",
      "accessToken",
      "refreshToken",
      "idToken",
      "userToken",
      "apiKey",
      "api_key",
      "APIKEY",
      "clientSecret",
      "Authorization",
    ]) {
      expect(isSecretKey(key), key).toBe(true)
    }
  })

  it("does not let the counter exemption swallow a second secret marker", () => {
    // "maxToken" would be exempt; "maxTokenSecret" carries "secret" and must
    // stay masked.
    expect(isSecretKey("maxTokenSecret")).toBe(true)
    expect(isSecretKey("tokensSecret")).toBe(true)
  })

  it("keeps non-secret keys non-secret", () => {
    for (const key of ["model", "cwd", "timeoutMs", "sessionName", "maxDepth"]) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })
})

describe("token counters survive every redactor", () => {
  it("redactPayload keeps numeric counters and masks credential keys in the same object", () => {
    expect(
      redactPayload({
        maxTokens: 4096,
        inputTokens: 120,
        tokensBefore: 900,
        model: "gpt-5",
        apiKey: "sk-live-abcdefghijklmnop",
        githubToken: "ghp_abcdefghij0123456789",
        nested: { tokenCount: 12, apiToken: "abc123" },
      }),
    ).toEqual({
      maxTokens: 4096,
      inputTokens: 120,
      tokensBefore: 900,
      model: "gpt-5",
      apiKey: "****",
      githubToken: "****",
      nested: { tokenCount: 12, apiToken: "****" },
    })
  })

  it("redactLogValue and redactSecrets agree on counters", () => {
    expect(redactLogValue({ maxTokens: 4096, apiKey: "sk-live-abcdefghijklmnop" })).toEqual({
      maxTokens: 4096,
      apiKey: "****",
    })
    expect(redactSecrets({ tokensUsed: 7, token: "ghp_abcdefghij0123456789" })).toEqual({
      tokensUsed: 7,
      token: "****",
    })
  })
})

describe("redactSecrets", () => {
  it("masks api keys", () => {
    expect(redactSecrets({ apiKey: "nvapi-1234567890abcdef" })).toEqual({ apiKey: "****" })
  })
  it("truncates long tokens", () => {
    const out = redactSecrets("sk-abcdefghijklmnopqrstuvwxyz012345") as string
    expect(out).toContain("****")
    expect(out).not.toContain("012345")
  })
  it("masks every known secret key shape, case-insensitively", () => {
    const out = redactSecrets({
      TOKEN: "abc",
      nested: { Authorization: "Bearer x", OTHER: "visible" },
    }) as Record<string, unknown>
    expect(out).toEqual({ TOKEN: "****", nested: { Authorization: "****", OTHER: "visible" } })
  })
  it("redacts inside arrays and truncates long bare strings", () => {
    const out = redactSecrets(["short", "x".repeat(40)]) as string[]
    expect(out[0]).toBe("short")
    expect(out[1]).toMatch(/^\S{4}\*\*\*\*$/)
  })
  it("passes non-secret scalars through untouched", () => {
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(null)).toBe(null)
    expect(redactSecrets("hello")).toBe("hello")
  })
  it("never leaks key material for provider prefixes", () => {
    for (const key of ["nvapi-123", "hf_abcdef", "xai-abcdef", "AIzaabcdef"]) {
      const out = String(redactSecrets(key))
      expect(out).not.toContain(key.slice(4))
    }
  })
})

describe("redactLogValue", () => {
  it("masks secret-named keys at any depth, including inside arrays", () => {
    expect(redactLogValue({ apiKey: "x", nested: { token: "y" }, list: [{ secret: "z" }] })).toEqual({
      apiKey: "****",
      nested: { token: "****" },
      list: [{ secret: "****" }],
    })
  })
  it("masks credential-shaped strings regardless of key name", () => {
    for (const key of ["sk-abcdefghijklmnop", "nvapi-123456", "Bearer abc.def.ghi", "hf_abcdef"]) {
      const out = String(redactLogValue(key))
      expect(out).toContain("****")
      expect(out).not.toContain(key.slice(4))
    }
  })
  it("leaves long ordinary log text intact (unlike redactSecrets)", () => {
    const filePath = "C:\\Users\\someone\\very\\long\\project\\path\\src\\index.ts"
    const msg = "command failed with a long but entirely ordinary description"
    expect(redactLogValue(filePath)).toBe(filePath)
    expect(redactLogValue(msg)).toBe(msg)
    expect(redactSecrets(filePath)).not.toBe(filePath)
  })
  it("passes non-secret scalars through untouched", () => {
    expect(redactLogValue(42)).toBe(42)
    expect(redactLogValue(null)).toBe(null)
    expect(redactLogValue(false)).toBe(false)
  })
})

describe("redactEmbeddedSecrets", () => {
  it("masks keys embedded mid-prose and keeps the prose", () => {
    const out = redactEmbeddedSecrets("call failed for nvapi-abcdefgh12345678, retry later")
    expect(out).toBe("call failed for [REDACTED], retry later")
    expect(redactEmbeddedSecrets("nothing secret here at all")).toBe("nothing secret here at all")
    expect(redactEmbeddedSecrets("auth: Bearer abc.def.ghi-jkl")).toBe("auth: [REDACTED]")
  })
})

describe("redactPayload", () => {
  const longPath = "C:\\Users\\someone\\very\\long\\project\\path\\src\\deeply\\nested\\index.ts"
  const longProse = "the quick brown fox jumps over the lazy dog and then keeps running for a very long time indeed"

  it("NEVER truncates ordinary strings, even past 24 chars (regression)", () => {
    // The entire reason this function exists: redactSecrets slices every
    // string >24 chars to `slice(0, 4) + "****"`, which shreds payloads.
    expect(longPath.length).toBeGreaterThan(24)
    expect(redactPayload(longPath)).toBe(longPath)
    expect(redactPayload(longProse)).toBe(longProse)
    expect(redactSecrets(longPath)).not.toBe(longPath)
    // …and a long string nested in a payload survives byte-for-byte too.
    expect(redactPayload({ cwd: longPath, note: longProse })).toEqual({ cwd: longPath, note: longProse })
  })

  it("masks secret-named keys at any depth", () => {
    expect(
      redactPayload({
        apiKey: "nvapi-1234567890abcdef",
        nested: { Authorization: "abc", visible: "keep" },
        list: [{ token: "xyz" }],
      }),
    ).toEqual({
      apiKey: "****",
      nested: { Authorization: "****", visible: "keep" },
      list: [{ token: "****" }],
    })
  })

  it("redacts credential material embedded mid-string without touching the prose", () => {
    expect(redactPayload("using sk-abcdefghijklmnop and retrying")).toBe("using [REDACTED] and retrying")
    expect(redactPayload("pushed with ghp_abcdefghij0123456789 yesterday")).toBe("pushed with [REDACTED] yesterday")
    expect(redactPayload("curl -H 'Authorization: Bearer abc.def.ghi' host")).toBe(
      "curl -H 'Authorization: [REDACTED]' host",
    )
    expect(redactPayload(longProse)).toBe(longProse)
  })

  it("masks credential-prefixed strings with a 4-char head + ****", () => {
    const out = String(redactPayload("Basic dXNlcjpwYXNzd29yZA"))
    expect(out).toMatch(/^Basi\*\*\*\*$/)
    expect(out).not.toContain("dXNlcjpwYXNz")
    // Short provider keys that the embedded pattern (≥8) skips still get masked.
    expect(String(redactPayload("sk-abc1234"))).toBe("sk-a****")
  })

  it("recurses arrays of arrays", () => {
    expect(redactPayload([["plain", 7], [{ apiKey: "x" }]])).toEqual([["plain", 7], [{ apiKey: "****" }]])
  })

  it("stops at a circular reference instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { path: longPath }
    cyclic.self = cyclic
    const out = redactPayload(cyclic) as Record<string, unknown>
    expect(out.path).toBe(longPath)
    expect(out.self).toBe("[Circular]")
  })

  it("walks a shared (non-cyclic) reference twice", () => {
    const shared = { token: "abc" }
    expect(redactPayload({ first: shared, second: shared })).toEqual({
      first: { token: "****" },
      second: { token: "****" },
    })
  })

  it("leaves non-string scalars untouched", () => {
    expect(redactPayload(42)).toBe(42)
    expect(redactPayload(0)).toBe(0)
    expect(redactPayload(false)).toBe(false)
    expect(redactPayload(null)).toBe(null)
    expect(redactPayload(undefined)).toBe(undefined)
  })
})

describe("secureDir", () => {
  it("creates the dir and returns it", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sec-")), "sub")
    expect(secureDir(dir)).toBe(dir)
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe("withFileLock", () => {
  it("runs the fn and releases the lock", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-lock-")), "s.json")
    const out = await withFileLock(file, () => 42)
    expect(out).toBe(42)
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
  it("releases the lock even when fn throws", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-lock-")), "s.json")
    await expect(withFileLock(file, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
})

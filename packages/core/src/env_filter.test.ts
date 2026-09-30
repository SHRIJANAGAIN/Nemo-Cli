/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

import { describe, expect, it } from "vitest"
import { BLOCKED_ENV_PATTERNS, createMinimalEnv, filterEnv, getSafeEnv, validateEnv } from "./env_filter.js"

describe("BLOCKED_ENV_PATTERNS", () => {
  it("covers the secret families the sandbox must never leak", () => {
    for (const pattern of [
      "SECRET",
      "KEY",
      "PASSWORD",
      "TOKEN",
      "CREDENTIAL",
      "AWS_",
      "GITHUB_",
      "BEARER",
      "JWT",
      "COOKIE",
      "SESSION",
      "AUTH",
      "DSN",
      "WEBHOOK",
      "DATABASE_URL",
      "DOCKER",
      "KUBE",
    ]) {
      expect(BLOCKED_ENV_PATTERNS).toContain(pattern)
    }
  })

  it("strips DSN/webhook/database/auth vars while keeping build env", () => {
    const out = filterEnv({
      DATABASE_URL: "postgres://u:p@h/db",
      SENTRY_DSN: "https://x@sentry.io/1",
      SLACK_WEBHOOK: "https://hooks/x",
      NPM_AUTH: "token",
      DOCKER_CONFIG: "/x",
      KUBECONFIG: "/y",
      PATH: "/usr/bin",
      NODE_ENV: "test",
    })
    expect(out).toEqual({ PATH: "/usr/bin", NODE_ENV: "test" })
  })

  it("blocks provider-scoped vars contributed by the sandbox list", () => {
    // None of these match the local entries (no KEY/SECRET/TOKEN substring):
    // without the sandbox union they leaked straight into bash children.
    const out = filterEnv({
      OPENAI_ORG: "org-x",
      ANTHROPIC_BASE_URL: "https://x",
      GOOGLE_CLOUD_PROJECT: "p",
      XAI_BASE_URL: "https://y",
      NVAPI_HOST: "h",
      SSH_AGENT_PID: "1234",
      HUGGINGFACE_HUB_CACHE: "/c",
      OLLAMA_HOST: "h",
      PATH: "/usr/bin",
      NODE_ENV: "test",
    })
    expect(out).toEqual({ PATH: "/usr/bin", NODE_ENV: "test" })
  })
})

describe("filterEnv", () => {
  it("strips secret-bearing variables case-insensitively and keeps the rest", () => {
    const input: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      LANG: "C.UTF-8",
      NODE_ENV: "test",
      API_KEY: "sk-123",
      db_password: "hunter2",
      AUTH_TOKEN: "tok",
      MY_CREDENTIAL: "cred",
      PRIVATE_KEY: "key",
      APP_SECRET: "shh",
      AWS_REGION: "us-east-1",
      GITHUB_SHA: "abc",
      GH_TOKEN: "gho",
    }

    const out = filterEnv(input)

    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8", NODE_ENV: "test" })
  })

  it("returns a new object and never mutates the input", () => {
    const input: Record<string, string> = { API_KEY: "x", KEEP: "y" }

    const out = filterEnv(input)

    expect(out).not.toBe(input)
    expect(input).toEqual({ API_KEY: "x", KEEP: "y" })
  })

  it("keeps an empty environment empty", () => {
    expect(filterEnv({})).toEqual({})
  })
})

describe("getSafeEnv", () => {
  it("filters secrets and stamps the sandbox marker", () => {
    const out = getSafeEnv({ KEEP: "yes", SECRET_X: "no", PATH: "/bin" } as NodeJS.ProcessEnv)

    expect(out["KEEP"]).toBe("yes")
    expect(out["PATH"]).toBe("/bin")
    expect(out["SECRET_X"]).toBeUndefined()
    expect(out["CODEX_SANDBOX"]).toBe("none")
    expect(out["CODEX_SANDBOX_NETWORK_DISABLED"]).toBeUndefined()
  })

  it("flags a network-disabled sandbox without leaking secrets", () => {
    const out = getSafeEnv({ TOKEN_X: "no", OK: "1" } as NodeJS.ProcessEnv, "seatbelt", /*networkDisabled*/ true)

    expect(out["TOKEN_X"]).toBeUndefined()
    expect(out["OK"]).toBe("1")
    expect(out["CODEX_SANDBOX"]).toBe("seatbelt")
    expect(out["CODEX_SANDBOX_NETWORK_DISABLED"]).toBe("true")
  })
})

describe("validateEnv", () => {
  it("reports exactly the blocked variable names", () => {
    const blocked = validateEnv({ API_KEY: "x", SAFE: "y", aws_secret: "z" } as NodeJS.ProcessEnv)

    expect(blocked.sort()).toEqual(["API_KEY", "aws_secret"].sort())
  })

  it("reports nothing for a clean environment", () => {
    expect(validateEnv({ PATH: "/bin", HOME: "/h" } as NodeJS.ProcessEnv)).toEqual([])
  })
})

describe("createMinimalEnv", () => {
  it("always carries the essentials plus the policy-only marker", () => {
    const env = createMinimalEnv()

    for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "TERM", "CODEX_SANDBOX"]) {
      expect(typeof env[key]).toBe("string")
    }
    expect(env["CODEX_SANDBOX"]).toBe("policy-only")
  })
})

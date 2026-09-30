/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto"
import {
  createAppJwt,
  describeGithubThread,
  extractFinalReply,
  parseTrayambakCommand,
  routeGithubEvent,
  selectJobReply,
  splitRepo,
  verifyWebhookSignature,
} from "./github-app.js"

const SECRET = "webhook-secret-for-tests"

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ action: "created" }))
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true)
  })

  it("rejects wrong secret, tampered body, and malformed headers", () => {
    const body = Buffer.from("hello")
    expect(verifyWebhookSignature("nope", body, sign(body))).toBe(false)
    expect(verifyWebhookSignature(SECRET, Buffer.from("hello!"), sign(body))).toBe(false)
    expect(verifyWebhookSignature(SECRET, body, "deadbeef")).toBe(false)
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false)
    expect(verifyWebhookSignature("", body, sign(body, ""))).toBe(false)
  })
})

describe("parseTrayambakCommand", () => {
  it("extracts tasks from /trayambak and @trayambak", () => {
    expect(parseTrayambakCommand("/trayambak fix the login bug")).toEqual({ task: "fix the login bug" })
    expect(parseTrayambakCommand("please @trayambak review this PR")).toEqual({ task: "review this PR" })
  })

  it("accepts the short /skt and @skt forms identically", () => {
    expect(parseTrayambakCommand("/skt fix the login bug")).toEqual({ task: "fix the login bug" })
    expect(parseTrayambakCommand("please @skt review this PR")).toEqual({ task: "review this PR" })
    expect(parseTrayambakCommand("/skt")).toBeNull()
  })

  it("rejects bare mentions, empty tasks, and chatter", () => {
    expect(parseTrayambakCommand("/trayambak")).toBeNull()
    expect(parseTrayambakCommand("/trayambak   ")).toBeNull()
    expect(parseTrayambakCommand("looks good, shipping it")).toBeNull()
    expect(parseTrayambakCommand("")).toBeNull()
  })
})

describe("routeGithubEvent", () => {
  const repo = { full_name: "acme/app" }

  it("answers ping", () => {
    expect(routeGithubEvent("ping", {})).toEqual({ kind: "pong" })
  })

  it("turns a created command comment into a job", () => {
    const out = routeGithubEvent("issue_comment", {
      action: "created",
      repository: repo,
      comment: { body: "/trayambak add retries" },
      issue: { number: 42 },
    })
    expect(out).toEqual({
      kind: "job",
      job: { repoFullName: "acme/app", issueNumber: 42, task: "add retries", isPullRequest: false },
    })
  })

  it("marks PR review comments as pull requests", () => {
    const out = routeGithubEvent("pull_request_review_comment", {
      action: "created",
      repository: repo,
      comment: { body: "/trayambak explain this hunk" },
      issue: { number: 7 },
    })
    expect(out.kind).toBe("job")
    if (out.kind === "job") expect(out.job.isPullRequest).toBe(true)
  })

  it("ignores edits, chatter, PR opens, pushes, and garbage", () => {
    const edited = routeGithubEvent("issue_comment", {
      action: "edited",
      repository: repo,
      comment: { body: "/trayambak do it" },
      issue: { number: 1 },
    })
    expect(edited.kind).toBe("ignored")
    expect(
      routeGithubEvent("issue_comment", {
        action: "created",
        repository: repo,
        comment: { body: "nice work" },
        issue: { number: 1 },
      }).kind,
    ).toBe("ignored")
    expect(routeGithubEvent("pull_request", { repository: repo }).kind).toBe("ignored")
    expect(routeGithubEvent("push", { repository: repo }).kind).toBe("ignored")
    expect(routeGithubEvent("ping", null).kind).toBe("pong")
    expect(routeGithubEvent("issue_comment", null).kind).toBe("ignored")
    expect(routeGithubEvent("issue_comment", { repository: repo }).kind).toBe("ignored")
  })
})

describe("createAppJwt", () => {
  it("mints a verifiable RS256 JWT with bounded life", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString()
    const nowSec = 1_800_000_000
    const jwt = createAppJwt("12345", priv, nowSec)
    const [h, p, s] = jwt.split(".")
    expect(h && p && s).toBeTruthy()
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, number | string>
    expect(payload.iss).toBe("12345")
    expect(payload.iat).toBe(nowSec - 60)
    expect(payload.exp).toBe(nowSec + 600)
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${h}.${p}`)
    verifier.end()
    expect(verifier.verify(pub, Buffer.from(s!, "base64url"))).toBe(true)
  })
})

describe("splitRepo", () => {
  it("splits owner/repo and rejects garbage", () => {
    expect(splitRepo("acme/app")).toEqual({ owner: "acme", repo: "app" })
    expect(() => splitRepo("nope")).toThrow()
    expect(() => splitRepo("")).toThrow()
  })
})

describe("extractFinalReply", () => {
  it("prefers the last assistant text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ]
    expect(extractFinalReply(messages)).toBe("second")
  })

  it("falls back to the last tool result when the model answers tool-only", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
      { role: "tool", content: [{ type: "text", text: "tool said this" }] },
    ]
    expect(extractFinalReply(messages)).toContain("tool said this")
  })

  it("never returns empty", () => {
    expect(extractFinalReply([])).toBe("(agent produced no text output)")
    expect(extractFinalReply([{ role: "assistant", content: [] }])).toBe("(agent produced no text output)")
  })
})

describe("selectJobReply", () => {
  it("prefers thrown errors, then real replies, then captured provider errors", () => {
    expect(selectJobReply([], "boom", ["[model error: x]"])).toBe("Agent run failed: boom")
    expect(
      selectJobReply([{ role: "assistant", content: [{ type: "text", text: "hi" }] }], "", ["[model error: x]"]),
    ).toBe("hi")
    expect(selectJobReply([{ role: "user", content: "hi" }], "", ["[model/connection error: 401 nope]"])).toContain(
      "401 nope",
    )
    expect(selectJobReply([], "", [])).toBe("(agent produced no text output)")
  })
})

describe("describeGithubThread", () => {
  it("hands issue + triggering comment to the prompt, truncated", () => {
    const out = describeGithubThread({
      issue: { number: 1, title: "HELLO", body: "hello body" },
      comment: { body: "/trayambak hello", user: { login: "boss" } },
    })
    expect(out).toContain("Issue #1: HELLO")
    expect(out).toContain("hello body")
    expect(out).toContain("Triggering comment by boss")
    expect(out).toContain("/trayambak hello")
    expect(describeGithubThread(null)).toBe("")
    expect(describeGithubThread({})).toBe("")
  })
})

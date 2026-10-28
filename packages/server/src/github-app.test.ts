/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto"
import {
  createAppJwt,
  describeGithubThread,
  extractFinalReply,
  parseNemoCommand,
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

describe("parseNemoCommand", () => {
  it("extracts tasks from /nemo and @nemo", () => {
    expect(parseNemoCommand("/nemo fix the login bug")).toEqual({ task: "fix the login bug" })
    expect(parseNemoCommand("please @nemo review this PR")).toEqual({ task: "review this PR" })
  })

  it("accepts the short /nemo and @nemo forms identically", () => {
    expect(parseNemoCommand("/nemo fix the login bug")).toEqual({ task: "fix the login bug" })
    expect(parseNemoCommand("please @nemo review this PR")).toEqual({ task: "review this PR" })
    expect(parseNemoCommand("/nemo")).toBeNull()
  })

  it("matches prefixes case-insensitively but keeps the task's own case", () => {
    expect(parseNemoCommand("/NEMO ADD LINKS OF FOLDER AND VIDEO'S")).toEqual({
      task: "ADD LINKS OF FOLDER AND VIDEO'S",
    })
    expect(parseNemoCommand("please @Nemo review this PR")).toEqual({ task: "review this PR" })
    expect(parseNemoCommand("/NEMO")).toBeNull()
  })

  it("rejects bare mentions, empty tasks, and chatter", () => {
    expect(parseNemoCommand("/nemo")).toBeNull()
    expect(parseNemoCommand("/nemo   ")).toBeNull()
    expect(parseNemoCommand("looks good, shipping it")).toBeNull()
    expect(parseNemoCommand("")).toBeNull()
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
      comment: { body: "/nemo add retries", user: { login: "human", type: "User" } },
      issue: { number: 42 },
    })
    expect(out).toEqual({
      kind: "job",
      job: { repoFullName: "acme/app", issueNumber: 42, task: "add retries", isPullRequest: false },
    })
  })

  it("never answers bot comments, even when the text carries a trigger", () => {
    // The agent echoes the triggering "/nemo …" line in its replies —
    // without this guard every reply re-triggers a full job (live spam loop).
    const ownReply = routeGithubEvent("issue_comment", {
      action: "created",
      repository: repo,
      sender: { login: "nemo-cli[bot]", type: "Bot" },
      comment: {
        body: "## Nemo result\n\nI ran /nemo add retries and it is done.",
        user: { login: "nemo-cli[bot]", type: "Bot" },
      },
      issue: { number: 42 },
    })
    expect(ownReply).toEqual({ kind: "ignored", reason: "bot comment (self-trigger guard)" })
    // Sender-only shape (some events slim the comment user down).
    const senderOnly = routeGithubEvent("issue_comment", {
      action: "created",
      repository: repo,
      sender: { login: "nemo-cli[bot]", type: "Bot" },
      comment: { body: "/nemo add retries" },
      issue: { number: 42 },
    })
    expect(senderOnly).toEqual({ kind: "ignored", reason: "bot comment (self-trigger guard)" })
  })

  it("marks PR review comments as pull requests", () => {
    const out = routeGithubEvent("pull_request_review_comment", {
      action: "created",
      repository: repo,
      comment: { body: "/nemo explain this hunk" },
      issue: { number: 7 },
    })
    expect(out.kind).toBe("job")
    if (out.kind === "job") expect(out.job.isPullRequest).toBe(true)
  })

  it("ignores edits, chatter, PR opens, pushes, and garbage", () => {
    const edited = routeGithubEvent("issue_comment", {
      action: "edited",
      repository: repo,
      comment: { body: "/nemo do it" },
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
      comment: { body: "/nemo hello", user: { login: "boss" } },
    })
    expect(out).toContain("Issue #1: HELLO")
    expect(out).toContain("hello body")
    expect(out).toContain("Triggering comment by boss")
    expect(out).toContain("/nemo hello")
    expect(describeGithubThread(null)).toBe("")
    expect(describeGithubThread({})).toBe("")
  })
})

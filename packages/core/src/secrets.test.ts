import { describe, expect, it } from "vitest"
import { redactSecrets } from "./secrets.js"

describe("redactSecrets", () => {
  it("masks api keys", () => {
    expect(redactSecrets({ apiKey: "nvapi-1234567890abcdef" })).toEqual({ apiKey: "****" })
  })
  it("truncates long tokens", () => {
    const out = redactSecrets("sk-abcdefghijklmnopqrstuvwxyz012345") as string
    expect(out).toContain("****")
    expect(out).not.toContain("012345")
  })
})

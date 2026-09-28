/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import { t } from "./i18n.js"

describe("i18n", () => {
  it("en + hi", () => {
    expect(t("logged_in", "en")).toContain("Logged in")
    expect(t("logged_in", "hi")).toContain("login")
  })
  it("falls back to key", () => {
    expect(t("nope", "xx")).toBe("nope")
  })
})

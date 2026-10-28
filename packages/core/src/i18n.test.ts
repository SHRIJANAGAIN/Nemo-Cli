/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
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

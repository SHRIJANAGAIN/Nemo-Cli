/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { normalizeUrls } from "./url.js"

describe("normalizeUrls", () => {
  it("leaves already-ASCII hostnames behind userinfo untouched", () => {
    // The permission dialog must show exactly what will run: credentials
    // must not be deleted, and the host must not be spliced into userinfo.
    expect(normalizeUrls("curl https://admin@example.com/x")).toBe("curl https://admin@example.com/x")
    expect(normalizeUrls("curl https://admin:secret@example.com/x")).toBe("curl https://admin:secret@example.com/x")
    expect(normalizeUrls("curl https://u:p@example.com:8443/y")).toBe("curl https://u:p@example.com:8443/y")
  })

  it("still punycodes an IDN hostname behind userinfo", () => {
    expect(normalizeUrls("curl https://аdmin@аpitest.com/x")).toBe("curl https://аdmin@xn--pitest-2nf.com/x")
  })

  it("punycodes plain IDN hostnames (regression guard)", () => {
    expect(normalizeUrls("curl https://аpitest.com/status")).toBe("curl https://xn--pitest-2nf.com/status")
  })

  it("passes prose with trailing punctuation through unchanged", () => {
    expect(normalizeUrls("see https://example.com.")).toBe("see https://example.com.")
  })
})
/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { credentialsPath, loginWithApiKey, logout, loginStatus } from "./auth.js"

const savedKey = process.env.NEMO_API_KEY

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-auth-"))
  process.env.NEMO_CREDENTIALS_FILE = path.join(dir, "credentials.json")
  delete process.env.NEMO_API_KEY
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.NEMO_API_KEY
  else process.env.NEMO_API_KEY = savedKey
})

describe("auth", () => {
  it("login/logout/status cycle", () => {
    expect(loginStatus().kind).toBe("none")
    loginWithApiKey("sk-test-123")
    expect(loginStatus().kind).toBe("api-key")
    expect(logout()).toBe(true)
    expect(loginStatus().kind).toBe("none")
  })

  it("logout clears without deleting the file (no path oracle)", () => {
    loginWithApiKey("sk-test-123")
    expect(logout()).toBe(true)
    expect(fs.existsSync(credentialsPath())).toBe(true)
    expect(loginStatus()).toEqual({ kind: "none", hasFile: false, hasEnv: false })
  })

  it("logout on a missing file returns false", () => {
    expect(logout()).toBe(false)
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { GitHubOAuthStore } from "./github-oauth.js"

function tmpStore(): { store: GitHubOAuthStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "gh-oauth-")), "oauth.json")
  return { store: new GitHubOAuthStore(file), file }
}

describe("GitHubOAuthStore", () => {
  it("begins, consumes once, and files tokens per machine", () => {
    const { store, file } = tmpStore()
    const st = store.beginLogin("machine-1")
    expect(st.machineId).toBe("machine-1")
    expect(st.state.length).toBeGreaterThan(10)
    // Single-use: first consume wins, replay dies.
    expect(store.consumeState(st.state)).toBe("machine-1")
    expect(store.consumeState(st.state)).toBeNull()
    expect(store.consumeState("nope")).toBeNull()
    // Token lifecycle + persistence across instances.
    expect(store.tokenFor("machine-1")).toBeUndefined()
    store.storeToken("machine-1", "tok-abc", "octocat")
    expect(store.tokenFor("machine-1")).toMatchObject({ login: "octocat" })
    const reopened = new GitHubOAuthStore(file)
    expect(reopened.tokenFor("machine-1")?.token).toBe("tok-abc")
    expect(reopened.size).toBe(1)
    expect(reopened.logout("machine-1")).toBe(true)
    expect(reopened.logout("machine-1")).toBe(false)
    expect(reopened.tokenFor("machine-1")).toBeUndefined()
  })

  it("replaces stale pending states per machine (newest tab wins)", () => {
    const { store } = tmpStore()
    const first = store.beginLogin("machine-1")
    const second = store.beginLogin("machine-1")
    expect(second.state).not.toBe(first.state)
    expect(store.consumeState(first.state)).toBeNull()
    expect(store.consumeState(second.state)).toBe("machine-1")
  })
})

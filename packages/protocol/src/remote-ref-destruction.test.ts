/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Deleting a ref on the REMOTE is the same hazard the force-push rules already
 * gate, and for the same documented reason: once the ref is gone from the
 * remote it is gone for every collaborator, and no local reflog restores it.
 * `git push --mirror` is strictly worse than `--force` — it deletes every ref on
 * the remote that has no local counterpart, not just the one being overwritten.
 *
 * Measured before the fix, every one of these returned `allow` under
 * `--ui-mode auto-approve`:
 *   git push --mirror origin          git push --delete origin feature/x
 *   git push origin :feature/x        git push origin --delete feature/x
 *   git push -d origin feature/x      git push upstream :main
 *   git push origin +main
 *
 * The second half of this file matters as much as the first: the destructive
 * refspec can sit on either side of the remote name and the delete flag can
 * follow the remote as well as precede it, so the rules are globs rather than
 * literals. That breadth is only safe if ordinary work still passes unprompted,
 * which is what the "routine work" cases below exist to prove.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearSessionPermissionRules, evaluatePermission } from "./permission-rules.js"
import { DEFAULT_PERMISSIONS, type PermissionConfig } from "./permissions.js"

function cfg(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return { ...DEFAULT_PERMISSIONS, ...overrides }
}

const bare = () => cfg({ rules: [] })

function verdict(command: string): { action: string; pattern: string; reason: string } {
  const d = evaluatePermission("bash", { command }, bare(), { uiMode: "auto-approve" })
  return {
    action: d.action,
    pattern: String(d.rule?.pattern ?? d.source),
    reason: String(d.rule?.reason ?? d.source),
  }
}

beforeEach(() => {
  clearSessionPermissionRules()
})

describe("remote ref destruction gates even under auto-approve", () => {
  it("asks for every form that deletes or overwrites a remote ref", () => {
    for (const command of [
      // Pre-existing coverage — must not regress.
      "git push --force origin main",
      "git push -f origin main",
      "git push --force-with-lease origin main",
      // The gaps this file is about.
      "git push --mirror origin",
      "git push --mirror",
      "git push --delete origin feature/x",
      "git push -d origin feature/x",
      "git push origin --delete feature/x",
      "git push origin :feature/x",
      "git push upstream :main",
      "git push origin +main",
    ]) {
      expect(verdict(command).action, command).toBe("ask")
    }
  })

  it("attributes the newly covered forms to the remote-destruction rule", () => {
    // The force-push forms deliberately keep their own `force push` reason —
    // that reason is what round 16 moved into the irreversible set, and
    // relabelling them would make that history unreadable.
    for (const command of [
      "git push --mirror origin",
      "git push --delete origin feature/x",
      "git push origin :feature/x",
      "git push origin --delete feature/x",
      "git push upstream :main",
      "git push origin +main",
    ]) {
      expect(verdict(command).reason, command).toBe("remote ref destruction")
    }
    for (const command of ["git push --force origin main", "git push -f origin main"]) {
      expect(verdict(command).reason, command).toBe("force push")
    }
  })

  it("asks in default mode too, not only under auto-approve", () => {
    for (const command of ["git push --mirror origin", "git push origin :feature/x", "git push origin --delete x"]) {
      const d = evaluatePermission("bash", { command }, bare(), { uiMode: "ask" })
      expect(d.action, command).toBe("ask")
    }
  })
})

describe("the wider patterns do not turn routine work into a prompt wall", () => {
  it("still allows ordinary pushes, tags, and local branch deletion", () => {
    for (const command of [
      "git push origin feature/x",
      "git push origin main",
      "git push upstream main",
      "git push --tags origin",
      "git push --all origin",
      // `--prune` removes only stale LOCAL remote-tracking refs, which a
      // re-fetch restores, so it is not remote destruction.
      "git push --prune origin",
      // Local deletion is recoverable and stays out of the gate.
      "git branch --delete feature/x",
      "git branch -d feature/x",
      "git commit -m 'feat: add x'",
      "npm test",
    ]) {
      expect(verdict(command).action, command).toBe("allow")
    }
  })

  it("is not fooled by a colon in a commit message ahead of the push", () => {
    // The refspec rules are anchored on `git push `, so text that merely
    // contains a colon earlier in a compound command must not trip them.
    expect(verdict("git commit -m 'fix: something' && git push origin main").action).toBe("allow")
  })

  it("asks on a destructive command merely quoted inside other text", () => {
    // Documented limitation, pinned so it cannot change silently. Every rule in
    // this table is a substring match, so a command that only *mentions* a
    // destructive string also gates: `echo 'git push --delete x'` asks, exactly
    // as the pre-existing `curl http` rule matches `echo "use curl http"`.
    // Erring toward a prompt is the intended direction, and disambiguating
    // would need a real argv parser rather than a pattern list.
    expect(verdict("echo 'how do I git push --delete safely?'").action).toBe("ask")
  })
})

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  AT_PATTERN,
  deriveMentionState,
  mentionSettled,
  filterMentions,
  insertMention,
  walkProjectFiles,
  type MentionCandidate,
} from "./file-mention.js"

const KNOWN = ["src/a.ts", "src/a.tsx", "docs/my report.txt", "docs/"]

afterEach(() => {
  // walk fixtures clean themselves up per-test below; nothing global here.
})

describe("AT_PATTERN / deriveMentionState", () => {
  it("opens on a bare @ at the end", () => {
    expect(deriveMentionState("@")).toEqual({ query: "", atIndex: 0 })
  })

  it("opens mid-sentence after whitespace", () => {
    expect(deriveMentionState("fix the bug in @")).toEqual({ query: "", atIndex: 15 })
    expect(deriveMentionState("fix @sr")).toEqual({ query: "sr", atIndex: 4 })
  })

  it("never triggers inside a word (emails, package scopes)", () => {
    expect(deriveMentionState("mail user@host now")).toBeNull()
    expect(deriveMentionState("import x from '@types/node'")).toBeNull()
  })

  it("keeps spaces inside the query (paths with spaces)", () => {
    expect(deriveMentionState("see @docs/my report.txt")).toEqual({
      query: "docs/my report.txt",
      atIndex: 4,
    })
  })

  it("a later @ restarts the query instead of swallowing the first", () => {
    const state = deriveMentionState("first @old then @new")
    expect(state).toEqual({ query: "new", atIndex: 16 })
    expect(AT_PATTERN.test("first @old then @new")).toBe(true)
  })

  it("trims trailing whitespace from the query", () => {
    expect(deriveMentionState("look @src/a.ts   ")).toEqual({ query: "src/a.ts", atIndex: 5 })
  })

  it("returns null when there is no @ at all", () => {
    expect(deriveMentionState("plain prose")).toBeNull()
    expect(deriveMentionState("")).toBeNull()
  })
})

describe("mentionSettled", () => {
  const token = { atIndex: 0, token: "src/a.ts" }

  it("closes the menu once the inserted path is followed by a space", () => {
    expect(mentionSettled("src/a.ts ", "src/a.ts", KNOWN)).toBe(true)
    expect(deriveMentionState("@src/a.ts ", KNOWN, token)).toBeNull()
  })

  it("stays closed while prose is typed after the mention", () => {
    expect(deriveMentionState("@src/a.ts and then some prose", KNOWN, token)).toBeNull()
  })

  it("stays open while the query is still shorter than the token", () => {
    expect(deriveMentionState("@sr", KNOWN, token)).not.toBeNull()
  })

  it("stays open when the char after the token is not whitespace (typing toward a longer path)", () => {
    expect(deriveMentionState("@src/a.tsx", KNOWN, token)).not.toBeNull()
  })

  it("reopens when a different @ is in play", () => {
    // Same token, but the active mention sits at another index.
    expect(deriveMentionState("@src/a.ts stuff @d", KNOWN, token)).toEqual({ query: "d", atIndex: 16 })
  })
})

describe("filterMentions", () => {
  const candidates: MentionCandidate[] = [
    { value: "src/deep/nested/agent.ts", kind: "file" },
    { value: "agent.ts", kind: "file" },
    { value: "docs/", kind: "folder" },
    { value: "src/", kind: "folder" },
    { value: "README.md", kind: "file" },
  ]

  it("ranks the bare basename above deeper paths", () => {
    const result = filterMentions("agent.ts", candidates)
    expect(result[0]?.value).toBe("agent.ts")
    expect(result.map((c) => c.value)).toContain("src/deep/nested/agent.ts")
  })

  it("empty query lists folders first, then files, alphabetically", () => {
    const result = filterMentions("", candidates)
    expect(result.map((c) => c.value)).toEqual(["docs/", "src/", "agent.ts", "README.md", "src/deep/nested/agent.ts"])
  })

  it("returns only matches for a query", () => {
    const result = filterMentions("readme", candidates)
    expect(result.map((c) => c.value)).toEqual(["README.md"])
  })

  it("returns nothing when nothing matches", () => {
    expect(filterMentions("zzzzqqq", candidates)).toEqual([])
  })

  it("respects the limit", () => {
    const many: MentionCandidate[] = Array.from({ length: 200 }, (_, i) => ({
      value: `file-${i}.ts`,
      kind: "file" as const,
    }))
    expect(filterMentions("file", many, 7)).toHaveLength(7)
    expect(filterMentions("", many, 5)).toHaveLength(5)
  })

  it("matches a query with spaces against a spaced path", () => {
    const result = filterMentions("my report", [{ value: "docs/my report.txt", kind: "file" }])
    expect(result[0]?.value).toBe("docs/my report.txt")
  })
})

describe("insertMention", () => {
  it("replaces the query and appends a separating space", () => {
    expect(insertMention("fix @sr", "", "src/")).toBe("fix @src/ ")
  })

  it("works when the buffer is only the mention", () => {
    expect(insertMention("@sr", "", "a.ts")).toBe("@a.ts ")
  })

  it("preserves the whitespace after the cursor (no double space)", () => {
    expect(insertMention("look @sr", " now", "src")).toBe("look @src now")
  })

  it("keeps paths that contain spaces intact", () => {
    expect(insertMention("@sr", "", "docs/my report.txt")).toBe("@docs/my report.txt ")
  })
})

describe("walkProjectFiles", () => {
  let tmp = ""

  afterEach(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true })
      tmp = ""
    }
  })

  it("lists files and folders, skips ignored dirs, uses forward slashes", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tray-mention-"))
    fs.mkdirSync(path.join(tmp, "src", "nested"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "src", "app.ts"), "x")
    fs.writeFileSync(path.join(tmp, "src", "nested", "deep.ts"), "x")
    fs.writeFileSync(path.join(tmp, "package.json"), "{}")
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "node_modules", "pkg", "index.js"), "x")
    fs.mkdirSync(path.join(tmp, ".git", "objects"), { recursive: true })
    fs.writeFileSync(path.join(tmp, ".git", "config"), "x")

    const entries = await walkProjectFiles(tmp)
    const values = entries.map((e) => e.value)

    expect(values).toEqual(
      expect.arrayContaining(["src/", "src/app.ts", "src/nested/", "src/nested/deep.ts", "package.json"]),
    )
    expect(values.some((v) => v.includes("node_modules"))).toBe(false)
    expect(values.some((v) => v.includes(".git"))).toBe(false)
    expect(values.every((v) => !v.includes("\\"))).toBe(true)

    const folder = entries.find((e) => e.value === "src/")
    expect(folder?.kind).toBe("folder")
    expect(entries.find((e) => e.value === "package.json")?.kind).toBe("file")
  })

  it("never throws on a missing or unreadable directory", async () => {
    await expect(walkProjectFiles(path.join(os.tmpdir(), "tray-mention-does-not-exist-xyz"))).resolves.toEqual([])
  })
})

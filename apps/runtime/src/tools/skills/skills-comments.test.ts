/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { parseSkillFile } from "./skills.js"

describe("SKILL.md frontmatter inline comments", () => {
  it("strips trailing # comments from cwd and timeout (the documented syntax)", () => {
    // The module doc itself shows `cwd: ./scripts # optional` and
    // `timeout: 60 # optional seconds` as valid frontmatter, but the parser
    // kept the comment in cwd and turned the timeout into NaN (dropped).
    const spec = parseSkillFile(
      "---\nname: s\ndescription: d\ncwd: ./scripts # optional\ntimeout: 60 # seconds\n---\nbody",
      "x.md",
    )
    expect(spec?.timeout).toBe(60) // RED: undefined (Number("60 # seconds") is NaN)
    expect(spec?.cwd).toBe("./scripts") // RED: "./scripts # optional"
  })

  it("keeps a # inside a quoted value (e.g. a URL fragment)", () => {
    const spec = parseSkillFile('---\nname: u\ndescription: d\ncwd: "https://x.test/p#frag"\n---\nbody', "y.md")
    expect(spec?.cwd).toBe("https://x.test/p#frag")
  })
})
/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Renderer markdown contract: assistant text renders markdown, model
 * output can never inject HTML, and links are protocol-limited. The
 * tests evaluate the EXACT bytes the app loads (no bundler sits between
 * them), so `renderer/markdown.js` and these assertions cannot drift.
 */

import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vm from "node:vm"

interface MarkdownModule {
  trayambakEscapeHtml: (value: string) => string
  trayambakRenderMarkdown: (source: string) => string
}

function loadMarkdownModule(): MarkdownModule {
  const file = path.join(__dirname, "..", "renderer", "markdown.js")
  const sandbox: { module: { exports: Record<string, unknown> } } = { module: { exports: {} } }
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file })
  const exports = sandbox.module.exports
  if (typeof exports.trayambakRenderMarkdown !== "function") {
    throw new Error("renderer/markdown.js did not export trayambakRenderMarkdown")
  }
  return exports as unknown as MarkdownModule
}

const { trayambakRenderMarkdown: render, trayambakEscapeHtml: escape } = loadMarkdownModule()

describe("renderer markdown", () => {
  it("renders the common structural subset", () => {
    const html = render(
      [
        "# Title",
        "",
        "Some **bold** and `code` and *italic*.",
        "",
        "- first",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted",
        "",
        "---",
      ].join("\n"),
    )
    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain("<em>italic</em>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>first</li>")
    expect(html).toContain("<li>second</li>")
    expect(html).toContain("</ul>")
    expect(html).toContain("<ol>")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<li>two</li>")
    expect(html).toContain("</ol>")
    expect(html).toContain("<blockquote>quoted</blockquote>")
    expect(html).toContain("<hr />")
  })

  it("renders fenced code verbatim with its content escaped", () => {
    const html = render("before\n```js\nif (a < b && c > d) {\n  x()\n}\n```\nafter")
    expect(html).toContain('<pre class="code"><code>if (a &lt; b &amp;&amp; c &gt; d) {')
    expect(html).toContain("before")
    expect(html).toContain("after")
    // The fence must not leak its own backticks as text.
    expect(html).not.toContain("```")
  })

  it("escapes raw HTML from the model instead of rendering it", () => {
    const html = render('<script>alert(1)</script><img src=x onerror="y()">')
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
  })

  it("only emits links for http(s)/mailto targets", () => {
    const ok = render("[docs](https://example.com/a)")
    expect(ok).toContain('<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">docs</a>')

    const bad = render("[click](javascript:alert(1))")
    expect(bad).not.toContain("<a ")
    expect(bad).toContain("javascript:alert(1)") // literal text, escaped context

    const image = render("![x](data:text/html,<script>)")
    expect(image).not.toContain("<img")
  })

  it("escapeHtml covers every byte that can open a tag or an attribute", () => {
    expect(escape('<a href="x">&\'')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;")
  })
})

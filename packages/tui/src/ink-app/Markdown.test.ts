/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { MarkdownBlock, parseBlocks, parseInlineSpans } from "./Markdown.js"

/**
 * Transcript markdown rendering — raw syntax (`**`, `###`, `[t](u)`)
 * must never reach the screen. Parsers are pinned pure; one live Ink
 * render proves the frames carry styled text, not markers.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function renderText(text: string): Promise<string> {
  const raw = new PassThrough()
  let sink = ""
  raw.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns: 100, rows: 40 }) as unknown as NodeJS.WriteStream

  let instance: Instance | undefined
  try {
    instance = render(React.createElement(MarkdownBlock, { text }), { stdout, patchConsole: false })
    await wait(400)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return stripAnsi(sink)
}

describe("parseInlineSpans", () => {
  it("splits bold, italic, code, strike, and links", () => {
    const spans = parseInlineSpans("**bold** and *ital* and `code` and ~~gone~~ and [t](http://u)")

    expect(spans.find((s) => s.text === "bold")?.bold).toBe(true)
    expect(spans.find((s) => s.text === "ital")?.italic).toBe(true)
    expect(spans.find((s) => s.text === "code")?.code).toBe(true)
    expect(spans.find((s) => s.text === "gone")?.strike).toBe(true)
    const link = spans.find((s) => s.text === "t")
    expect(link?.linkUrl).toBe("http://u")
  })

  it("leaves unclosed markers and escapes literal", () => {
    expect(
      parseInlineSpans("a **half")
        .map((s) => s.text)
        .join(""),
    ).toBe("a **half")
    expect(
      parseInlineSpans("a `tick")
        .map((s) => s.text)
        .join(""),
    ).toBe("a `tick")
    expect(parseInlineSpans("\\*not ital\\*").every((s) => !s.italic)).toBe(true)
  })

  it("nests italic inside bold", () => {
    const spans = parseInlineSpans("**bold and *deep***")
    const deep = spans.find((s) => s.text === "deep")

    expect(deep?.bold).toBe(true)
    expect(deep?.italic).toBe(true)
  })

  it("keeps images as labeled text with the url attached", () => {
    const spans = parseInlineSpans("![alt](http://img)")

    expect(spans).toHaveLength(1)
    expect(spans[0]?.text).toBe("alt")
    expect(spans[0]?.linkUrl).toBe("http://img")
  })
})

describe("parseBlocks", () => {
  it("classifies headings, lists, quotes, rules, code, and tables", () => {
    const blocks = parseBlocks(
      [
        "# Title",
        "",
        "- item",
        "1. first",
        "> quoted",
        "---",
        "```js",
        "const x = 1;",
        "```",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "plain",
      ].join("\n"),
    )

    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "list",
      "quote",
      "rule",
      "code",
      "table",
      "paragraph",
    ])
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1 })
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: true })
    expect(blocks[5]).toMatchObject({ kind: "code", lines: ["const x = 1;"] })
  })

  it("keeps unclosed fences as code to the end", () => {
    const blocks = parseBlocks(["text", "```", "still code"].join("\n"))

    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "code"])
  })

  it("drops the alignment row and column-aligns table cells", () => {
    const blocks = parseBlocks(["| a | b |", "|---|---|", "| 1 | longer |", "", "p"].join("\n"))
    const table = blocks.find((b) => b.kind === "table")

    expect(table?.lines).toEqual(["a │ b", "1 │ longer"])
  })

  it("ignores inline markers inside fenced code", () => {
    const blocks = parseBlocks(["```", "**not bold**", "```"].join("\n"))
    const code = blocks.find((b) => b.kind === "code")

    expect(code?.lines).toEqual(["**not bold**"])
  })
})

describe("MarkdownBlock render", () => {
  it("paints styled text without raw markers", async () => {
    const frames = await renderText(
      [
        "### Running services",
        "",
        "**pocketbase.exe** + [log](file:///C:/x.log)",
        "",
        "- item one",
        "> note here",
      ].join("\n"),
    )

    expect(frames).toContain("Running services")
    expect(frames).toContain("pocketbase.exe")
    expect(frames).toContain("item one")
    expect(frames).not.toContain("###")
    expect(frames).not.toContain("**")
    expect(frames).not.toContain("](file:///")
  }, 15000)

  it("renders code fences literally", async () => {
    const frames = await renderText(["```js", "**not bold**", "```"].join("\n"))

    expect(frames).toContain("**not bold**")
  }, 15000)
})

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"

/**
 * Markdown renderer for the transcript — assistant answers and tool
 * results arrive as raw markdown (`**bold**`, `###`, `[text](url)`) and
 * must never paint as literal syntax. Zero dependencies: a small scanner
 * for inline spans plus a line-level block parser, both pure and tested.
 *
 * Deliberately NOT a full spec implementation: tables render as plain
 * rows, nested lists flatten with indentation, and unclosed markers stay
 * literal (a half-streamed `**` must not swallow the line).
 */

export interface InlineSpan {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  strike: boolean
  linkUrl?: string
}

const emptyFlags = { bold: false, italic: false, code: false, strike: false }

/**
 * Closing-run matcher for `**` / `~~`: a closer is a run of the marker of
 * length >= 2. A bare indexOf would stop at the FIRST `*` of a closing
 * `***` (breaking `**bold and *deep***` nesting) or match a lone `*`
 * inside the span. Runs longer than 2 (e.g. `***`) close here and leave
 * the surplus marker for the next pass.
 */
function findClosingRun(input: string, from: number, marker: string): number {
  const m = marker[0]!
  let i = from
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2
      continue
    }
    if (input.startsWith(marker, i)) {
      // Odd-length runs (`***`): the closer is the LAST two stars, leaving
      // one for an inner emphasis (`**a *b***` → bold holds italic b).
      let run = 0
      while (input[i + run] === m) run++
      return run % 2 === 1 ? i + 1 : i
    }
    i++
  }
  return -1
}

/** Split text into styled spans. Pure. */
export function parseInlineSpans(input: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let plain = ""
  const flush = (): void => {
    if (plain) {
      spans.push({ text: plain, ...emptyFlags })
      plain = ""
    }
  }
  const pushInner = (inner: string, flag: "bold" | "italic" | "strike"): void => {
    flush()
    for (const span of parseInlineSpans(inner)) {
      spans.push({ ...span, [flag]: true })
    }
  }

  let i = 0
  while (i < input.length) {
    const rest = input.slice(i)
    if (rest.startsWith("\\") && i + 1 < input.length) {
      plain += input[i + 1]
      i += 2
      continue
    }
    if (rest.startsWith("**")) {
      const close = findClosingRun(input, i + 2, "**")
      if (close === -1) {
        plain += "**"
        i += 2
        continue
      }
      pushInner(input.slice(i + 2, close), "bold")
      i = close + 2
      continue
    }
    if (rest.startsWith("`")) {
      const close = input.indexOf("`", i + 1)
      if (close === -1) {
        plain += "`"
        i += 1
        continue
      }
      flush()
      spans.push({ text: input.slice(i + 1, close), ...emptyFlags, code: true })
      i = close + 1
      continue
    }
    if (rest.startsWith("~~")) {
      const close = findClosingRun(input, i + 2, "~~")
      if (close === -1) {
        plain += "~~"
        i += 2
        continue
      }
      pushInner(input.slice(i + 2, close), "strike")
      i = close + 2
      continue
    }
    if (rest.startsWith("![") || rest.startsWith("[")) {
      const isImage = rest.startsWith("![")
      const openLen = isImage ? 2 : 1
      const closeBracket = findClosingBracket(input, i + openLen)
      if (closeBracket !== -1 && input[closeBracket + 1] === "(") {
        const closeParen = input.indexOf(")", closeBracket + 2)
        if (closeParen !== -1) {
          flush()
          const label = input.slice(i + openLen, closeBracket)
          const url = input.slice(closeBracket + 2, closeParen)
          spans.push({ text: label || url, ...emptyFlags, linkUrl: url })
          i = closeParen + 1
          continue
        }
      }
      plain += input[i]
      i += 1
      continue
    }
    if ((rest.startsWith("*") || rest.startsWith("_")) && i + 1 < input.length) {
      const marker = input[i]!
      const close = input.indexOf(marker, i + 1)
      if (close === -1 || close === i + 1) {
        plain += marker
        i += 1
        continue
      }
      pushInner(input.slice(i + 1, close), "italic")
      i = close + 1
      continue
    }
    plain += input[i]
    i += 1
  }
  flush()
  return spans
}

/** `]` matcher that skips nested `[...]` pairs (e.g. badges in labels). */
function findClosingBracket(input: string, from: number): number {
  let depth = 0
  for (let i = from; i < input.length; i++) {
    if (input[i] === "[") depth++
    else if (input[i] === "]") {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

export type BlockKind = "heading" | "paragraph" | "list" | "code" | "quote" | "rule" | "table"

export interface Block {
  kind: BlockKind
  /** Heading level (1-6) or list indent in spaces. */
  level: number
  ordered: boolean
  lines: string[]
}

/** Split text into render blocks. Pure. */
export function parseBlocks(input: string): Block[] {
  const blocks: Block[] = []
  const lines = input.split("\n")
  let i = 0
  let inFence = false
  const codeLines: string[] = []

  const flushParagraph: string[] = []
  const flushPara = (): void => {
    if (flushParagraph.length > 0) {
      blocks.push({ kind: "paragraph", level: 0, ordered: false, lines: [...flushParagraph] })
      flushParagraph.length = 0
    }
  }

  while (i < lines.length) {
    const line = lines[i]!
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (!inFence) {
        flushPara()
        inFence = true
        codeLines.length = 0
      } else {
        blocks.push({ kind: "code", level: 0, ordered: false, lines: [...codeLines] })
        inFence = false
      }
      i++
      continue
    }
    if (inFence) {
      codeLines.push(line)
      i++
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      blocks.push({ kind: "heading", level: heading[1]!.length, ordered: false, lines: [heading[2] ?? ""] })
      i++
      continue
    }
    if (/^\s*(\*\*\*|---|___)\s*$/.test(line)) {
      flushPara()
      blocks.push({ kind: "rule", level: 0, ordered: false, lines: [] })
      i++
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushPara()
      const quoted: string[] = [quote[1] ?? ""]
      i++
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^>\s?/, ""))
        i++
      }
      blocks.push({ kind: "quote", level: 0, ordered: false, lines: quoted })
      continue
    }
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (listItem) {
      flushPara()
      blocks.push({
        kind: "list",
        level: (listItem[1] ?? "").length,
        ordered: /^\d/.test(listItem[2] ?? ""),
        lines: [listItem[3] ?? ""],
      })
      i++
      continue
    }
    if (line.trim() === "") {
      flushPara()
      i++
      continue
    }
    // Table: header row with pipes followed by an alignment row.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      flushPara()
      const cells: string[][] = []
      let j = i
      while (j < lines.length && lines[j]!.includes("|")) {
        const row = lines[j]!
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(row)) {
          const parts = row.split("|").map((cell) => cell.trim())
          // Drop the empty cells a leading/trailing pipe produces, but keep
          // interior empties — blank cells must still hold their column.
          if (parts.length > 0 && parts[0] === "") parts.shift()
          if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
          cells.push(parts)
        }
        j++
      }
      // Column-align: pad every cell to its column's widest entry so rows
      // line up as a real table instead of ragged `│` joins. Widths use the
      // DISPLAYED text (markers stripped by the inline parser) — measuring
      // raw `` `code` `` would overcount by the backticks and shift that
      // column's `│` left by 2.
      const displayWidth = (cell: string): number =>
        parseInlineSpans(cell).reduce((n, span) => n + span.text.length, 0)
      const widths: number[] = []
      for (const rowCells of cells) {
        rowCells.forEach((cell, ci) => {
          widths[ci] = Math.max(widths[ci] ?? 0, displayWidth(cell))
        })
      }
      const rows = cells.map((rowCells) =>
        rowCells
          .map((cell, ci) => cell + " ".repeat(Math.max(0, (widths[ci] ?? 0) - displayWidth(cell))))
          .join(" │ ")
          .trimEnd(),
      )
      blocks.push({ kind: "table", level: 0, ordered: false, lines: rows })
      i = j
      continue
    }
    flushParagraph.push(line)
    i++
  }
  if (inFence) {
    blocks.push({ kind: "code", level: 0, ordered: false, lines: [...codeLines] })
  }
  flushPara()
  return blocks
}

function SpanText({ span, color }: { span: InlineSpan; color?: string }): ReactNode {
  const theme = useThemeColors()
  const base = color ?? theme.markdownText
  if (span.code) return <Text color={theme.markdownCode}>{span.text}</Text>
  if (span.linkUrl !== undefined) {
    const displayUrl = span.linkUrl.startsWith("file://") ? span.linkUrl.slice("file://".length) : span.linkUrl
    const showUrl = displayUrl !== span.text
    return (
      <Text>
        <Text color={theme.markdownLink}>{span.text}</Text>
        {showUrl && <Text color={theme.textMuted}> ({displayUrl})</Text>}
      </Text>
    )
  }
  return (
    <Text color={base} bold={span.bold} italic={span.italic} strikethrough={span.strike}>
      {span.text}
    </Text>
  )
}

/** Inline-only rendering for single lines (tool previews, one-line rows). */
export function MarkdownInline({ text, color }: { text: string; color?: string }): ReactNode {
  return (
    <Text>
      {parseInlineSpans(text).map((span, idx) => (
        <SpanText key={idx} span={span} color={color} />
      ))}
    </Text>
  )
}

/** Full block rendering for assistant answers. */
export function MarkdownBlock({ text }: { text: string }): ReactNode {
  const theme = useThemeColors()
  return (
    <Box flexDirection="column">
      {parseBlocks(text).map((block, idx) => {
        switch (block.kind) {
          case "heading":
            return (
              <Box key={idx} marginTop={idx === 0 ? 0 : 1}>
                <Text color={theme.markdownHeading} bold>
                  {block.lines.map((line, li) => (
                    <MarkdownInline key={li} text={line} color={theme.markdownHeading} />
                  ))}
                </Text>
              </Box>
            )
          case "list": {
            const indent = " ".repeat(Math.min(6, block.level))
            return (
              <Box key={idx}>
                <Text>
                  <Text color={theme.primary}>{`${indent}${block.ordered ? "1." : "•"} `}</Text>
                  <MarkdownInline text={block.lines.join("\n")} />
                </Text>
              </Box>
            )
          }
          case "code":
            return (
              <Box key={idx} flexDirection="column" marginLeft={2} marginTop={1}>
                {block.lines.map((line, li) => (
                  <Text key={li} color={theme.markdownCode}>
                    {line || " "}
                  </Text>
                ))}
              </Box>
            )
          case "quote":
            return (
              <Box key={idx} flexDirection="column" marginTop={1}>
                {block.lines.map((line, li) => (
                  <Text key={li}>
                    <Text color={theme.markdownBlockQuote}>{"▎ "}</Text>
                    <MarkdownInline text={line} />
                  </Text>
                ))}
              </Box>
            )
          case "rule":
            return (
              <Box key={idx} marginTop={1}>
                <Text color={theme.border}>{"─".repeat(40)}</Text>
              </Box>
            )
          case "table":
            return (
              <Box key={idx} flexDirection="column" marginTop={1}>
                {block.lines.map((line, li) => (
                  // Cells run through the inline parser: a `` `code` `` or
                  // `**bold**` inside a cell must render styled, never with
                  // its markers on screen (the raw-`|` screenshot class).
                  <Text key={li} color={theme.textMuted}>
                    {line ? <MarkdownInline text={line} color={theme.textMuted} /> : " "}
                  </Text>
                ))}
              </Box>
            )
          default:
            return (
              <Box key={idx} marginTop={idx === 0 ? 0 : 1} flexDirection="column">
                {block.lines.map((line, li) => (
                  <Text key={li}>
                    <MarkdownInline text={line} />
                  </Text>
                ))}
              </Box>
            )
        }
      })}
    </Box>
  )
}

export default MarkdownBlock

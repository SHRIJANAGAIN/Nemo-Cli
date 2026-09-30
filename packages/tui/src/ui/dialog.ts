/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { BOLD, DIM, paint, paintBg } from "./theme"
import { renderBox } from "./box"
import { toolResultPreview, toolDisplayName, toolTitleArgs } from "./tool-display"

export type ToolRow = {
  name: string
  args: Record<string, unknown>
  result?: string
  ok?: boolean
  overflow?: boolean
}

/** Unified diff renderer with line-number gutters and added/removed backgrounds. */
export function renderDiffUnified(before: string, after: string, maxLines = 40): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const out: string[] = []
  const max = Math.min(maxLines, Math.max(a.length, b.length))
  for (let i = 0; i < max; i++) {
    const l = a[i],
      r = b[i]
    const num = paint("diffLineNumber", String(i + 1).padStart(4))
    if (l === r) {
      out.push(paintBg("diffContext", "diffContextBg", ` ${num}  ${(l ?? "").slice(0, 100)}`))
    } else {
      if (l !== undefined) {
        out.push(paintBg("diffRemoved", "diffRemovedBg", ` ${num} - ${(l ?? "").slice(0, 100)}`))
      }
      if (r !== undefined) {
        out.push(paintBg("diffAdded", "diffAddedBg", ` ${num} + ${(r ?? "").slice(0, 100)}`))
      }
    }
  }
  return (
    out.join("\n") +
    (max < Math.max(a.length, b.length) ? paint("textMuted", ` … (${Math.max(a.length, b.length) - max} more)`) : "")
  )
}

/** Markdown-lite renderer for assistant replies. */
export function renderMarkdownLite(text: string, width = 96): string {
  const lines = text.split("\n")
  const out: string[] = []
  let inCode = false
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(paint("markdownCodeBlock", raw))
      continue
    }
    if (/^#{1,6}\s/.test(raw)) {
      out.push(paint("markdownHeading", raw.replace(/^#+\s/, ""), BOLD))
      continue
    }
    if (/^\s*[-*]\s/.test(raw)) {
      out.push(paint("markdownListEnumeration", "  • ") + paint("markdownListItem", raw.replace(/^\s*[-*]\s/, "")))
      continue
    }
    if (/^\s*\d+\.\s/.test(raw)) {
      out.push("  " + paint("markdownListEnumeration", raw.trimStart()))
      continue
    }
    if (raw.trim() === "---") {
      out.push(paint("markdownHorizontalRule", "─".repeat(Math.min(width, 60))))
      continue
    }
    // inline: **bold**, `code`, [text](url)
    let line = raw
    line = line.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => paint("markdownStrong", t, BOLD))
    line = line.replace(/`([^`]+)`/g, (_m, t: string) => paint("markdownCode", t))
    line = line.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, t: string, u: string) => paint("markdownLinkText", t) + paint("markdownLink", ` (${u})`),
    )
    out.push(line)
  }
  return out.join("\n")
}

/** Tool-call block: title row with </> marker, collapsed preview, expand hint. */
export function renderToolBlock(row: ToolRow, expandHint = "[ctrl+o expand]"): string {
  const title = `${toolDisplayName(row.name)} ${toolTitleArgs(row.name, row.args)}`
  const header = paint("primary", "╱╱ ") + paint("text", title, BOLD)
  if (row.result === undefined) return header
  const marker = row.ok ? paint("success", "<^>") : paint("error", "<!>")
  const preview = toolResultPreview(row.result, row.ok ?? true)
  const hint = row.overflow ? "  " + paint("textMuted", expandHint, DIM) : ""
  return `${header}\n  ${marker} ${paint("textMuted", preview)}${hint}`
}

/** Assistant reply bubble (rounded, themed). */
export function renderReplyBubble(text: string): string {
  return renderBox(text, { border: "rounded", borderColor: "border", paddingX: 2, paddingY: 1, maxWidth: 90 })
}

/** User message quote-block. */
export function renderUserQuote(text: string): string {
  return text
    .split("\n")
    .map((l) => paint("secondary", "▌ ") + paint("text", l))
    .join("\n")
}

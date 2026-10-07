/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** Unified-diff parse + render + output shaping (codex diff_render port,
 *  Ink-plain-text edition).
 *
 *  Codex renders diffs as: `• Edited <path> (+a -r)` header, per-hunk
 *  old/new line numbers with a +/- gutter, and a spacer between hunks;
 *  long command output is head+tail capped (never first-N-only, because
 *  the tail usually holds the verdict). Same techniques here, as pure
 *  string functions so both the edit_file tool (mini-diff) and the TUI
 *  (/diff, tool rows) share them. ASCII-only: +/- markers, no block art.
 */

export type DiffLineType = " " | "+" | "-"

export interface DiffLine {
  type: DiffLineType
  oldNo?: number
  newNo?: number
  text: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  kind: "edited" | "added" | "deleted"
  hunks: DiffHunk[]
  adds: number
  dels: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

/** Parse unified diff text into per-file structures. Tolerant: unknown
 *  lines (index lines, mode lines, "\ No newline" markers) are skipped;
 *  a hunk header with no parseable body still yields an empty hunk. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const pushHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk)
    hunk = null
  }

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line.startsWith("diff --git ")) {
      pushHunk()
      const m = / b\/(.+)$/.exec(line)
      current = { path: m?.[1] ?? "unknown", kind: "edited", hunks: [], adds: 0, dels: 0 }
      files.push(current)
      continue
    }
    if (line.startsWith("+++ ") && !hunk) {
      if (current) {
        const p = line.slice(4).trim().replace(/^b\//, "")
        if (p === "/dev/null") current.kind = "deleted"
        else current.path = p
      }
      continue
    }
    if (line.startsWith("--- ") && !hunk) {
      if (current) {
        const p = line.slice(4).trim().replace(/^a\//, "")
        if (p === "/dev/null") current.kind = "added"
      }
      continue
    }
    const hm = HUNK_RE.exec(line)
    if (hm) {
      pushHunk()
      hunk = {
        oldStart: num(hm[1], 1),
        oldLines: num(hm[2], 1),
        newStart: num(hm[3], 1),
        newLines: num(hm[4], 1),
        lines: [],
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }
    if (!hunk || !current) continue
    const marker = line[0]
    if (marker === " " || marker === "+" || marker === "-") {
      const entry: DiffLine = { type: marker, text: line.slice(1) }
      if (marker !== "+") entry.oldNo = oldNo++
      if (marker !== "-") entry.newNo = newNo++
      hunk.lines.push(entry)
      if (marker === "+") current.adds++
      if (marker === "-") current.dels++
    }
    // "\ No newline at end of file" and friends: skipped deliberately.
  }
  pushHunk()
  return files.filter((f) => f.hunks.length > 0)
}

/** `(+a -r)` stat suffix shared by every diff header. */
export function diffStatLine(adds: number, dels: number): string {
  return `(+${adds} -${dels})`
}

export interface RenderDiffOptions {
  /** Max body rows per file before the `… +N more` marker (default 60). */
  maxRows?: number
  /** Max hunk bodies per file (default 8). */
  maxHunks?: number
}

/** Render one file diff codex-style: `• Edited <path> (+a -r)`, hunk
 *  headers with old/new ranges, numbered +/-/context rows, and a `:`
 *  spacer between hunks. Plain strings — the caller (Ink <Text> or tool
 *  result) decides coloring. */
export function renderFileDiff(file: FileDiff, opts: RenderDiffOptions = {}): string[] {
  const maxRows = opts.maxRows ?? 60
  const maxHunks = opts.maxHunks ?? 8
  const verb = file.kind === "added" ? "Added" : file.kind === "deleted" ? "Deleted" : "Edited"
  const out: string[] = [`• ${verb} ${file.path} ${diffStatLine(file.adds, file.dels)}`]
  let rows = 0
  let capped = false
  const hunks = file.hunks.slice(0, maxHunks)
  hunks.forEach((h, hi) => {
    if (capped) return
    if (hi > 0) out.push(":")
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) {
      if (rows >= maxRows) {
        const remaining =
          h.lines.length - h.lines.indexOf(l) + file.hunks.slice(hi + 1).reduce((n, x) => n + x.lines.length, 0)
        out.push(`… +${remaining} more lines`)
        capped = true
        break
      }
      const no = l.type === "-" ? l.oldNo : l.newNo
      out.push(`${l.type} ${(no ?? "").toString().padStart(5, " ")} ${l.text}`)
      rows++
    }
  })
  if (file.hunks.length > maxHunks) out.push(`… +${file.hunks.length - maxHunks} more hunks`)
  return out
}

/** Multi-file render with the `Edited N files (+tot -tot)` rollup header
 *  (codex multi-file form). Caps at 6 files, then a summary line. */
export function renderDiffFiles(files: FileDiff[], opts: RenderDiffOptions = {}): string[] {
  if (files.length === 0) return ["No changes."]
  const adds = files.reduce((n, f) => n + f.adds, 0)
  const dels = files.reduce((n, f) => n + f.dels, 0)
  const out: string[] =
    files.length === 1 && files[0] ? [] : [`Edited ${files.length} files ${diffStatLine(adds, dels)}`]
  const shown = files.slice(0, 6)
  for (const f of shown) {
    if (files.length > 1) out.push(`└ ${f.path} ${diffStatLine(f.adds, f.dels)}`)
    out.push(...renderFileDiff(f, opts))
  }
  if (files.length > shown.length) out.push(`… +${files.length - shown.length} more files`)
  return out
}

/** Compact old→new line diff for edit_file results (opencode
 *  structured-final port): `-` removed, `+` added, capped with a marker.
 *  Line-oriented (no LCS): the removed block then the added block. */
export function miniDiff(oldText: string, newText: string, maxLines = 20): string[] {
  const olds = String(oldText ?? "").split("\n")
  const news = String(newText ?? "").split("\n")
  const out: string[] = []
  for (const l of olds) {
    if (out.length >= maxLines) break
    out.push(`- ${l}`)
  }
  for (const l of news) {
    if (out.length >= maxLines) break
    out.push(`+ ${l}`)
  }
  const total = olds.length + news.length
  if (total > out.length) out.push(`… +${total - out.length} more lines`)
  return out
}

/** Head+tail middle truncation for long tool output (codex live_output
 *  port): `headRows` first, a `… +N lines …` marker, then `tailRows`. The tail carries the verdict, so first-N-only is never
 *  what the transcript shows. */
export function truncateMiddleLines(lines: string[], headRows = 4, tailRows = 3): string[] {
  if (lines.length <= headRows + tailRows + 1) return lines
  const omitted = lines.length - headRows - tailRows
  return [...lines.slice(0, headRows), `… +${omitted} lines …`, ...lines.slice(lines.length - tailRows)]
}

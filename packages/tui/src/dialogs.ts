/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** Popup dialog / palette components for the TRAYAMBAK terminal UI (plain ANSI). */

import { COLOR } from "./index"
import { setThemeByName, fg as trueFg, listThemes, applyTerminalTheme } from "./ui/theme"
import { toolDisplayName } from "./ui/tool-display"
import { PALETTE } from "./ui/tool-palette"
import { stringWidth as displayWidth, sliceByWidth, padToWidth } from "./ink-app/utils/stringWidth.js"
export { listThemes }

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

export function visibleWidth(s: string): number {
  // npm string-width: grapheme- and ANSI-aware, the same module Ink wraps
  // Text with — `stripAnsi(s).length` counted UTF-16 units, over-counting
  // Devanagari matras/virama and drifting from the rendered text.
  return displayWidth(s)
}

/** Render a centered bordered popup box with a title and body lines. */
export function renderPopup(
  title: string,
  lines: string[],
  opts?: { width?: number; accent?: keyof typeof COLOR },
): string {
  const width = opts?.width ?? Math.min(84, Math.max(title.length + 8, ...lines.map((l) => visibleWidth(l) + 6)))
  const accent = opts?.accent ?? "cyan"
  const out: string[] = []
  const pad = (n: number) => " ".repeat(n)
  const top = "┌" + "─".repeat(width - 2) + "┐"
  const bottom = "└" + "─".repeat(width - 2) + "┘"
  const titleVisible = ` ${title} `
  const titlePad = width - 2 - titleVisible.length
  const titleLeft = Math.max(1, Math.floor(titlePad / 2))
  out.push(
    COLOR[accent] +
      top.slice(0, 1 + titleLeft) +
      COLOR.bold +
      titleVisible +
      COLOR.reset +
      COLOR[accent] +
      top.slice(1 + titleLeft + titleVisible.length) +
      COLOR.reset,
  )
  out.push(COLOR[accent] + "│" + COLOR.reset + pad(width - 2) + COLOR[accent] + "│" + COLOR.reset)
  for (const line of lines) {
    const vis = visibleWidth(line)
    // Clip rows wider than the box (terminal-ui.popup does this; without it a
    // long LSP root path shoved the right border columns past the other rows).
    const body = vis > width - 4 ? sliceByWidth(line, width - 4) : line
    const inner = " " + body + pad(Math.max(0, width - 4 - visibleWidth(body))) + " "
    out.push(COLOR[accent] + "│" + COLOR.reset + inner + COLOR[accent] + "│" + COLOR.reset)
  }
  out.push(COLOR[accent] + "│" + COLOR.reset + pad(width - 2) + COLOR[accent] + "│" + COLOR.reset)
  out.push(COLOR[accent] + bottom + COLOR.reset)
  return out.join("\n")
}

/** Braille spinner frames (smooth dot-style spin). */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Todo checklist item: [✓] done, [•] in progress, [ ] pending. */
export function renderTodoItem(status: string, content: string): string {
  const mark =
    status === "completed"
      ? `${COLOR.green}✓${COLOR.reset}`
      : status === "in_progress"
        ? `${COLOR.yellow}•${COLOR.reset}`
        : " "
  const color = status === "completed" ? COLOR.dim : status === "in_progress" ? COLOR.yellow : COLOR.white
  return ` ${COLOR.dim}[${COLOR.reset}${mark}${COLOR.dim}]${COLOR.reset} ${color}${content}${COLOR.reset}`
}

/** Render a full todo checklist block inside a popup. */
export function renderTodoList(title: string, items: Array<{ status: string; content: string }>): string {
  const lines = items.length
    ? items.map((t) => renderTodoItem(t.status, t.content))
    : [COLOR.dim + "  (no tasks)" + COLOR.reset]
  return renderPopup(title, lines, { accent: "yellow" })
}

export interface PaletteAction {
  name: string
  description: string
  shortcut?: string
  category?: string
}

/** Command palette popup — lists all actions with descriptions, categories, and key bindings (trayambak-style). */
export function renderCommandPalette(actions: PaletteAction[]): string {
  // Group by category
  const categories = new Map<string, PaletteAction[]>()
  for (const a of actions) {
    const cat = a.category ?? "General"
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push(a)
  }

  const lines: string[] = []
  for (const [cat, items] of categories) {
    lines.push(`${COLOR.dim}  ${cat}${COLOR.reset}`)
    for (const a of items) {
      const sc = a.shortcut ? COLOR.dim + `  (${a.shortcut})` + COLOR.reset : ""
      lines.push(
        `    ${COLOR.skyBlue}${COLOR.bold}${a.name.padEnd(16)}${COLOR.reset} ${COLOR.dim}${a.description}${COLOR.reset}${sc}`,
      )
    }
    lines.push("")
  }
  return renderPopup("COMMAND PALETTE", lines, { accent: "magenta" })
}

/** Simple key-value status table. */
export function renderStatusTable(rows: Array<[string, string]>): string {
  const lines = rows.map(([k, v]) => ` ${COLOR.cyan}${k.padEnd(16)}${COLOR.reset} ${COLOR.white}${v}${COLOR.reset}`)
  return renderPopup("STATUS", lines, { accent: "cyan" })
}

/** Session list dialog. */
export function renderSessionList(
  sessions: Array<{ id: string; title: string; updated: string; current?: boolean }>,
): string {
  const lines = sessions.map((s) => {
    const cur = s.current ? COLOR.green + "▶ " + COLOR.reset : "  "
    return `${cur}${COLOR.bold}${s.id.slice(0, 10)}${COLOR.reset}  ${COLOR.white}${s.title}${COLOR.reset}  ${COLOR.dim}${s.updated}${COLOR.reset}`
  })
  return renderPopup("SESSIONS", lines.length ? lines : [COLOR.dim + "  (no sessions)" + COLOR.reset], {
    accent: "blue",
  })
}

/** Skill list dialog. */
export function renderSkillList(skills: Array<{ name: string; description: string }>): string {
  const lines = skills.map(
    (s) =>
      ` ${COLOR.brightGreen}${COLOR.bold}${s.name.padEnd(20)}${COLOR.reset} ${COLOR.dim}${s.description}${COLOR.reset}`,
  )
  return renderPopup("SKILLS", lines.length ? lines : [COLOR.dim + "  (no skills installed)" + COLOR.reset], {
    accent: "green",
  })
}

/** Model picker dialog. */
export function renderModelDialog(models: Array<{ name: string; path: string; current?: boolean }>): string {
  const lines = models.map((m) => {
    const cur = m.current ? COLOR.green + "● " + COLOR.reset : COLOR.dim + "○ " + COLOR.reset
    return `${cur}${COLOR.bold}${m.name}${COLOR.reset}  ${COLOR.dim}${m.path}${COLOR.reset}`
  })
  return renderPopup("MODELS", lines.length ? lines : [COLOR.dim + "  (no models saved)" + COLOR.reset], {
    accent: "skyBlue",
  })
}

/** Persistent status bar footer (single line). */
export function renderStatusBar(opts: {
  model?: string
  session?: string
  cwd: string
  contextPercent?: number
}): string {
  const session = opts.session
    ? ` ${COLOR.dim}session:${COLOR.reset} ${COLOR.magenta}${opts.session}${COLOR.reset}`
    : ""
  const ctx =
    opts.contextPercent !== undefined
      ? ` ${COLOR.dim}ctx:${COLOR.reset} ${opts.contextPercent > 80 ? COLOR.red : COLOR.green}${opts.contextPercent}%${COLOR.reset}`
      : ""
  const cwd = ` ${COLOR.dim}${opts.cwd}${COLOR.reset}`
  return `${session}${ctx}${cwd}${COLOR.reset}`
}

/** File-change summary line (+adds / -dels). */
export function renderFileChange(file: string, added: number, removed: number): string {
  return ` ${file}  ${COLOR.green}+${added}${COLOR.reset} ${COLOR.red}-${removed}${COLOR.reset}`
}

/* ───────────────────────── Theme system ───────────────────────── */

export interface TrayambakTheme {
  name: string
  primary: string
  secondary: string
  accent: string
  error: string
  success: string
  muted: string
}

/** Built-in themes (256-color ANSI). */
export const THEMES: Record<string, TrayambakTheme> = {
  sky: {
    name: "sky",
    primary: "\x1b[38;5;39m",
    secondary: "\x1b[38;5;117m",
    accent: "\x1b[38;5;213m",
    error: "\x1b[38;5;203m",
    success: "\x1b[38;5;114m",
    muted: "\x1b[38;5;245m",
  },
  night: {
    name: "night",
    primary: "\x1b[38;5;99m",
    secondary: "\x1b[38;5;141m",
    accent: "\x1b[38;5;176m",
    error: "\x1b[38;5;168m",
    success: "\x1b[38;5;108m",
    muted: "\x1b[38;5;241m",
  },
  ocean: {
    name: "ocean",
    primary: "\x1b[38;5;33m",
    secondary: "\x1b[38;5;75m",
    accent: "\x1b[38;5;51m",
    error: "\x1b[38;5;196m",
    success: "\x1b[38;5;79m",
    muted: "\x1b[38;5;244m",
  },
  forest: {
    name: "forest",
    primary: "\x1b[38;5;71m",
    secondary: "\x1b[38;5;108m",
    accent: "\x1b[38;5;179m",
    error: "\x1b[38;5;167m",
    success: "\x1b[38;5;114m",
    muted: "\x1b[38;5;243m",
  },
  candy: {
    name: "candy",
    primary: "\x1b[38;5;205m",
    secondary: "\x1b[38;5;213m",
    accent: "\x1b[38;5;159m",
    error: "\x1b[38;5;196m",
    success: "\x1b[38;5;120m",
    muted: "\x1b[38;5;246m",
  },
  mono: {
    name: "mono",
    primary: "\x1b[38;5;250m",
    secondary: "\x1b[38;5;244m",
    accent: "\x1b[38;5;255m",
    error: "\x1b[38;5;248m",
    success: "\x1b[38;5;252m",
    muted: "\x1b[38;5;240m",
  },
}

let activeTheme: TrayambakTheme = THEMES.sky

export function setTheme(name: string): TrayambakTheme | null {
  const t = THEMES[name.toLowerCase()]
  if (t) {
    activeTheme = t
    applyTerminalTheme()
    return t
  }
  // Bridge to the full truecolor theme library (ui/theme.ts).
  const full = setThemeByName(name)
  if (full) {
    activeTheme = {
      name: full.name,
      primary: trueFg(full.primary as never),
      secondary: trueFg(full.secondary as never),
      accent: trueFg(full.accent as never),
      error: trueFg(full.error as never),
      success: trueFg(full.success as never),
      muted: trueFg(full.textMuted as never),
    }
    applyTerminalTheme()
    return activeTheme
  }
  return null
}

export function getTheme(): TrayambakTheme {
  return activeTheme
}

export function themeName(): string {
  return activeTheme.name
}

/** Theme list dialog — current one marked with ●. */
export function renderThemeList(): string {
  const lines = listThemes().map((full) => {
    const cur = full.name === activeTheme.name ? COLOR.green + "● " + COLOR.reset : COLOR.dim + "○ " + COLOR.reset
    const swatch =
      trueFg(full.primary as never) +
      "████" +
      trueFg(full.secondary as never) +
      "████" +
      trueFg(full.accent as never) +
      "████" +
      COLOR.reset
    const mode = full.dark ? "dark" : "light"
    return `${cur}${COLOR.bold}${full.name.padEnd(16)}${COLOR.reset} ${COLOR.dim}${mode.padEnd(5)}${COLOR.reset} ${swatch}`
  })
  return renderPopup("THEMES", lines, { accent: "skyBlue" })
}
/* ─────────────────────── Trayambak UI components ─────────────────────── */

/** Colored status dot (•) — green=connected, red=error, yellow=warning, gray=muted. */
export function renderStatusDot(status: "connected" | "error" | "warning" | "muted" | "disabled"): string {
  const colors: Record<string, string> = {
    connected: PALETTE.success,
    error: PALETTE.failure,
    warning: PALETTE.yellow,
    muted: PALETTE.dim,
    disabled: PALETTE.dim,
  }
  return `${colors[status] ?? PALETTE.dim}•${PALETTE.reset}`
}

/** Trayambak-style split logo: muted left half + bold right half with shadow gap. */
export function renderSplitLogo(art: string): string {
  const lines = art.split("\n")
  const width = Math.max(...lines.map((l) => l.length))
  const mid = Math.floor(width / 2)
  const out: string[] = []
  for (const line of lines) {
    const left = line.slice(0, mid)
    const right = line.slice(mid)
    // Left half = muted/dim, right half = bold white, 1-space shadow gap between
    const l = left.replace(/[^ ]/g, (ch) => `${COLOR.dim}${ch}${COLOR.reset}`)
    const r = right.replace(/[^ ]/g, (ch) => `${COLOR.bold}${COLOR.white}${ch}${COLOR.reset}`)
    out.push(l + " " + r)
  }
  return out.join("\n")
}

/** Startup loading screen — logo + braille spinner + status text (Trayambak-style). */
export function renderStartupLoading(logo: string, status: string, frame: number): string {
  const spinner = BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]
  const out: string[] = []
  out.push("")
  out.push(renderSplitLogo(logo))
  out.push("")
  out.push(`  ${COLOR.cyan}${spinner}${COLOR.reset} ${COLOR.dim}${status}${COLOR.reset}`)
  out.push("")
  return out.join("\n")
}

/** Status dialog — MCP/LSP servers, formatters, plugins with colored dots (Trayambak-style). */
export function renderStatusDialog(opts: {
  mcp?: Array<{ name: string; status: "connected" | "error" | "disabled" | "warning" }>
  lsp?: Array<{ name: string; status: "connected" | "error"; root: string }>
  formatters?: string[]
  plugins?: Array<{ name: string; version?: string }>
}): string {
  const lines: string[] = []

  // MCP Servers
  if (opts.mcp && opts.mcp.length > 0) {
    lines.push(`${COLOR.bold}  ${opts.mcp.length} MCP Servers${COLOR.reset}`)
    for (const s of opts.mcp) {
      const dot = renderStatusDot(s.status)
      const statusText: Record<string, string> = {
        connected: "Connected",
        error: "Failed",
        disabled: "Disabled",
        warning: "Needs auth",
      }
      lines.push(
        `    ${dot} ${COLOR.bold}${s.name}${COLOR.reset} ${COLOR.dim}${statusText[s.status] ?? s.status}${COLOR.reset}`,
      )
    }
    lines.push("")
  }

  // LSP Servers
  if (opts.lsp && opts.lsp.length > 0) {
    lines.push(`${COLOR.bold}  ${opts.lsp.length} LSP Servers${COLOR.reset}`)
    for (const s of opts.lsp) {
      const dot = renderStatusDot(s.status)
      lines.push(`    ${dot} ${COLOR.bold}${s.name}${COLOR.reset} ${COLOR.dim}${s.root}${COLOR.reset}`)
    }
    lines.push("")
  }

  // Formatters
  if (opts.formatters && opts.formatters.length > 0) {
    lines.push(`${COLOR.bold}  ${opts.formatters.length} Formatters${COLOR.reset}`)
    for (const f of opts.formatters) {
      lines.push(`    ${renderStatusDot("connected")} ${COLOR.bold}${f}${COLOR.reset}`)
    }
    lines.push("")
  }

  // Plugins
  if (opts.plugins && opts.plugins.length > 0) {
    lines.push(`${COLOR.bold}  ${opts.plugins.length} Plugins${COLOR.reset}`)
    for (const p of opts.plugins) {
      lines.push(
        `    ${renderStatusDot("connected")} ${COLOR.bold}${p.name}${COLOR.reset}${p.version ? ` ${COLOR.dim}@${p.version}${COLOR.reset}` : ""}`,
      )
    }
  }

  if (lines.length === 0) {
    lines.push(`${COLOR.dim}  No services configured${COLOR.reset}`)
  }

  return renderPopup("STATUS", lines, { accent: "cyan" })
}

/* ─────────────────────── Message bubbles ─────────────────────── */

/** Wrap text to a max visible width. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of paragraph.split(" ")) {
      if (line.length === 0) line = word
      else if (displayWidth(line) + 1 + displayWidth(word) <= width) line += " " + word
      else {
        out.push(line)
        line = word
      }
    }
    if (line) out.push(line)
  }
  // A token wider than the box (URL/code) would push the right border out
  // of place — hard-slice it at grapheme boundaries instead.
  return out.flatMap((l) => (displayWidth(l) <= width ? [l] : chunkLine(l, width)))
}

/** Split an over-long line into `width`-column chunks (cluster-safe: the
 *  prefix returned by sliceByWidth always ends on a grapheme boundary). */
function chunkLine(line: string, width: number): string[] {
  const chunks: string[] = []
  let rest = line
  while (displayWidth(rest) > width) {
    const head = sliceByWidth(rest, width)
    if (!head) break // first cluster wider than the box — degenerate
    chunks.push(head)
    rest = rest.slice(head.length)
  }
  chunks.push(rest)
  return chunks
}

/**
 * Assistant response inside a rounded-corner bubble, themed — the signature
 * message layout. Wraps long lines to fit the terminal.
 */
export function renderAssistantBubble(text: string, opts?: { width?: number }): string {
  const t = getTheme()
  const width = Math.min(opts?.width ?? 88, Math.max(40, (process.stdout.columns || 100) - 8))
  const inner = width - 4
  // Body rows = "│" + "  " + content + "  " + "│" — content must therefore
  // live in inner-2 columns, not inner: wrapping/padding at `inner` made
  // every body row 2 cells WIDER than the ╭…╮ corner rows, so the right
  // border stuck out past the box (Hindi mis-measurement added more drift).
  const content = inner - 2
  const lines = wrapText(text, content)
  const out: string[] = []
  out.push(t.primary + "╭" + "─".repeat(width - 2) + "╮" + COLOR.reset)
  out.push(t.primary + "│" + COLOR.reset + " ".repeat(width - 2) + t.primary + "│" + COLOR.reset)
  for (const line of lines) {
    const pad = " ".repeat(Math.max(0, content - displayWidth(line)))
    out.push(t.primary + "│" + COLOR.reset + "  " + line + pad + "  " + t.primary + "│" + COLOR.reset)
  }
  out.push(t.primary + "│" + COLOR.reset + " ".repeat(width - 2) + t.primary + "│" + COLOR.reset)
  out.push(t.primary + "╰" + "─".repeat(width - 2) + "╯" + COLOR.reset)
  return out.join("\n")
}

/** User message — compact quote block with theme accent. */
export function renderUserBubble(text: string): string {
  const t = getTheme()
  const width = Math.min(70, Math.max(30, (process.stdout.columns || 100) - 12))
  const inner = width - 4
  const lines = wrapText(text, inner)
  const out: string[] = []
  for (const line of lines) {
    out.push(t.secondary + "▌" + COLOR.reset + " " + COLOR.bold + line + COLOR.reset)
  }
  return out.join("\n")
}

/** Header bar rendered at top of each turn — themed title strip. */
export function renderHeader(title: string, subtitle: string): string {
  const t = getTheme()
  const cols = process.stdout.columns || 80
  const bar = t.primary + "─".repeat(cols) + COLOR.reset
  const mid = ` ${t.secondary}${COLOR.bold}${title}${COLOR.reset} ${t.muted}${subtitle}${COLOR.reset} `
  return bar + "\n" + mid + "\n" + bar
}

/* ─────────────────────── Diff & code rendering ─────────────────────── */

/** A single line in a unified diff. */
export interface DiffLine {
  kind: "context" | "add" | "del" | "info"
  text: string
}

/** Build a tiny LCS-based unified diff between two strings (line granularity). */
export function buildDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] })
      i++
    } else {
      out.push({ kind: "add", text: b[j] })
      j++
    }
  }
  while (i < m) {
    out.push({ kind: "del", text: a[i++] })
  }
  while (j < n) {
    out.push({ kind: "add", text: b[j++] })
  }
  return out
}

/** Render a unified diff with green + / red - / dim context lines and a gutter. */
export function renderDiff(file: string, before: string, after: string, maxLines = 40): string {
  const t = getTheme()
  const diff = buildDiff(before, after)
  const head = `${t.primary}${COLOR.bold} ${file} ${COLOR.reset}`
  const stat = (() => {
    const adds = diff.filter((d) => d.kind === "add").length
    const dels = diff.filter((d) => d.kind === "del").length
    return ` ${t.success}+${adds}${COLOR.reset} ${t.error}-${dels}${COLOR.reset}`
  })()
  const lines: string[] = [head + stat]
  const shown = diff.slice(0, maxLines)
  for (const d of shown) {
    const prefix =
      d.kind === "add" ? `${t.success}+${COLOR.reset}` : d.kind === "del" ? `${t.error}-${COLOR.reset}` : ` `
    const text =
      d.kind === "add"
        ? t.success + d.text + COLOR.reset
        : d.kind === "del"
          ? t.error + d.text + COLOR.reset
          : t.muted + d.text + COLOR.reset
    lines.push(`${prefix} ${text}`)
  }
  if (diff.length > maxLines) lines.push(`${t.muted}  ... ${diff.length - maxLines} more lines${COLOR.reset}`)
  return lines.join("\n")
}

/* ─────────────────────── Markdown & code blocks ─────────────────────── */

/** Lightweight markdown → ANSI. Supports headers, bold, italic, inline code, lists. */
export function renderMarkdown(text: string): string {
  const t = getTheme()
  const out: string[] = []
  for (const raw of text.split("\n")) {
    if (/^#{1,6}\s+/.test(raw)) {
      const level = raw.match(/^#+/)?.[0].length ?? 1
      const body = raw.replace(/^#+\s+/, "")
      const color = level === 1 ? t.primary : level === 2 ? t.secondary : t.accent
      out.push(`${color}${COLOR.bold}${body}${COLOR.reset}`)
      continue
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      const body = raw.replace(/^\s*[-*]\s+/, "")
      out.push(`  ${t.accent}•${COLOR.reset} ${applyInline(body, t)}`)
      continue
    }
    out.push(applyInline(raw, t))
  }
  return out.join("\n")
}

function applyInline(s: string, t: TrayambakTheme): string {
  let out = s.replace(/`([^`\n]+)`/g, (_m, code) => `${COLOR.bgBlue}${COLOR.white} ${code} ${COLOR.reset}`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, body) => `${COLOR.bold}${body}${COLOR.reset}`)
  out = out.replace(/\*([^*\n]+)\*/g, (_m, body) => `${COLOR.italic}${t.accent}${body}${COLOR.reset}`)
  return out
}

/** A bordered code block with optional language label. */
export function renderCodeBlock(code: string, lang = ""): string {
  const t = getTheme()
  const cols = process.stdout.columns || 100
  const inner = Math.max(40, cols - 6)
  const lines = code.split("\n").map((l) => (displayWidth(l) > inner ? sliceByWidth(l, inner - 1) + "…" : l))
  const out: string[] = []
  const langTag = lang ? ` ${t.accent}${COLOR.bold}${lang}${COLOR.reset} ` : ""
  // Border rows must agree on width: measure the tag with ANSI stripped
  // (raw .length counted escape bytes) and pad every body row out to
  // `inner` — unpadded rows left the right border stair-stepped.
  out.push(
    `${t.primary}╭─${langTag}${t.muted}${"─".repeat(Math.max(0, inner + 1 - displayWidth(langTag)))}╮${COLOR.reset}`,
  )
  for (const l of lines) {
    const rowPad = " ".repeat(Math.max(0, inner - displayWidth(l)))
    out.push(`${t.primary}│${COLOR.reset} ${t.secondary}${l}${COLOR.reset}${t.primary} ${rowPad}│${COLOR.reset}`)
  }
  out.push(`${t.primary}╰${"─".repeat(inner + 2)}╯${COLOR.reset}`)
  return out.join("\n")
}

/* ─────────────────────── Footer & autocomplete ─────────────────────── */

/** Persistent one-line footer shown above the prompt. */
export function renderFooter(opts: {
  model?: string
  cwd?: string
  session?: string
  build?: "pass" | "fail" | "skip" | "running"
  contextPercent?: number
  streaming?: boolean
  permissionMode?: "default" | "yolo"
}): string {
  const t = getTheme()
  const cols = process.stdout.columns || 100
  const segs: string[] = []
  if (opts.permissionMode) {
    const pm = opts.permissionMode
    segs.push(
      pm === "yolo"
        ? `${COLOR.bgRed}${COLOR.white}${COLOR.bold} YOLO ${COLOR.reset}`
        : `${COLOR.bgGreen}${COLOR.black}${COLOR.bold} ASK ${COLOR.reset}`,
    )
  }
  segs.push(`${COLOR.bgBlue}${COLOR.white}${COLOR.bold} TRAYAMBAK ${COLOR.reset}`)
  if (opts.session) segs.push(`${t.muted}session:${COLOR.reset} ${t.accent}${opts.session}${COLOR.reset}`)
  if (opts.contextPercent !== undefined) {
    const color = opts.contextPercent > 80 ? t.error : t.success
    segs.push(`${t.muted}ctx:${COLOR.reset} ${color}${opts.contextPercent}%${COLOR.reset}`)
  }
  if (opts.build) {
    const b = opts.build
    const color = b === "pass" ? t.success : b === "fail" ? t.error : t.muted
    segs.push(`${t.muted}build:${COLOR.reset} ${color}${b}${COLOR.reset}`)
  }
  if (opts.streaming) segs.push(`${t.accent}● streaming${COLOR.reset}`)
  // Always keep the footer to exactly one terminal row: a footer that wraps
  // onto a second row is what makes the subsequent composer carriage return
  // land on the wrong row on Windows ConPTY and "jump" the screen. Truncate
  // the tail instead of wrapping.
  // long tail instead of wrapping.
  const left = segs.join(" ")
  const visible = stripAnsi(left).replace(/﻿/g, "")
  if (displayWidth(visible) > cols) {
    // Drop the trailing cwd/model segments first (they are the least
    // important), then hard-truncate the tail.
    return (
      `${COLOR.bgBlue}${COLOR.white}${COLOR.bold} TRAYAMBAK ${COLOR.reset}${t.muted}…${COLOR.reset}` +
      stripAnsiTail(left)
    )
  }
  return left
}

/** Remove trailing segments until the footer fits one terminal row. */
function stripAnsiTail(built: string): string {
  // Split on segment boundaries (reset followed by a color code), trim from
  // the right until the excess is gone, then hard-clip.
  const segs = built.split(/(?=\[)/).filter(Boolean)
  let out = ""
  for (const seg of segs) {
    if (displayWidth(out + seg) > (process.stdout.columns || 100) - 20) break
    out += seg
  }
  const visible = stripAnsi(out)
  const cols = process.stdout.columns || 100
  if (out && displayWidth(visible) > cols - 1) {
    // Hard clip visible chars (keep ANSI intact by trimming whole segments).
    let acc = ""
    for (const seg of segs) {
      if (displayWidth(acc) + displayWidth(seg) > cols - 1) break
      acc += seg
    }
    return acc
  }
  // Drop leading whitespace-only segments so the tail is compact.
  return out
}

/** Slash-command autocomplete dropdown rendered as a vertical strip. */
export function renderAutocomplete(opts: {
  query: string
  matches: Array<{ label: string; description: string; key?: string }>
  active: number
  maxRows?: number
}): string {
  const t = getTheme()
  const maxRows = opts.maxRows ?? 6
  const lines: string[] = []
  if (opts.matches.length === 0) {
    lines.push(`${t.muted}  (no matches for /${opts.query})${COLOR.reset}`)
    return lines.join("\n")
  }
  const top = opts.matches.slice(0, maxRows)
  for (let i = 0; i < top.length; i++) {
    const m = top[i]
    const isActive = i === opts.active
    const mark = isActive ? `${t.primary}❯${COLOR.reset}` : " "
    const label = `${COLOR.bold}${padToWidth(m.label, 14)}${COLOR.reset}`
    const desc = `${t.muted}${m.description}${COLOR.reset}`
    const key = m.key ? `  ${t.muted}(${m.key})${COLOR.reset}` : ""
    const row = `${mark} ${label} ${desc}${key}`
    lines.push(isActive ? `${COLOR.bgBlue}${row}${COLOR.reset}` : row)
  }
  if (opts.matches.length > maxRows) {
    lines.push(`${t.muted}  ... ${opts.matches.length - maxRows} more${COLOR.reset}`)
  }
  return lines.join("\n")
}

/* ─────────────────────── Permissions & confirmations ─────────────────────── */

export interface PermissionRequest {
  tool: string
  args: string
  reason: string
}

/** A centred "Allow / Deny" prompt — Trayambak-style permission gate. */
export function renderPermission(req: PermissionRequest): string {
  const t = getTheme()
  const lines: string[] = [
    `${t.muted}  tool:${COLOR.reset}    ${COLOR.bold}${toolDisplayName(req.tool)}${COLOR.reset}`,
    `${t.muted}  args:${COLOR.reset}    ${t.secondary}${req.args}${COLOR.reset}`,
    `${t.muted}  reason:${COLOR.reset}  ${t.accent}${req.reason}${COLOR.reset}`,
    "",
    `  ${COLOR.bgGreen}${COLOR.bold} Y ${COLOR.reset} ${t.success}allow${COLOR.reset}    ${COLOR.bgRed}${COLOR.bold} N ${COLOR.reset} ${t.error}deny${COLOR.reset}    ${t.muted}(a/d)${COLOR.reset}`,
  ]
  return renderPopup("PERMISSION", lines, { accent: "yellow", width: 72 })
}

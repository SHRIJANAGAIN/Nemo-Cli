/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Command segmentation: split one shell command line into the sub-commands it
 * will actually execute.
 *
 * Why this exists: policy rules are matched against the WHOLE command string,
 * so a destructive payload hidden inside a wrapper never matches its own deny
 * rule — `ls $(rm -rf /tmp/x)`, `eval "rm -rf /"`, `cmd /c "del /s /q C:\…"`
 * and `echo x && rm -rf /` all matched nothing and degraded to a bare "ask".
 * The approval prompt then shows the innocuous wrapper, the user approves, and
 * the hidden payload runs unchecked. Worse, `checkExecPolicy` — the surface
 * `trayambak execpolicy check` reports — actually ALLOWED `cmd /c "del …"`.
 *
 * Every segment must therefore be evaluated, and the strictest verdict wins.
 *
 * Design constraints (fail-safe, not fail-open):
 *   - When the scanner cannot confidently parse the line, it returns the WHOLE
 *     command as one segment. Policy then behaves exactly as it did before —
 *     an unknown construct is never mistaken for a safe one.
 *   - Segments keep their original text (minus wrapper quoting) so existing
 *     anchored deny patterns like `rm -rf /*` still match.
 *   - Pure and total: no I/O, no globals, no throwing.
 */

/** Wrappers whose remaining arguments are themselves shell commands. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "busybox",
  "env",
  "xargs",
  "nohup",
  "time",
  "watch",
  "eval",
  "exec",
  "command",
  "nice",
  "stdbuf",
  "setsid",
  "doas",
  "sudo",
  "powershell",
  "pwsh",
  "cmd",
])

/** Flags that take a value we must not mistake for the wrapped command. */
const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set(["-c", "--command", "/c", "/k", "/e", "-command", "/command"])

/**
 * Recursively peel wrapper layers: `sudo bash -c "…"` and
 * `eval "$(cat /tmp/x)"` both reduce to their innermost command text.
 * Returns the original string when the line is not a wrapper.
 */
function unwrapWrapper(command: string): string {
  const trimmed = command.trim()
  if (trimmed === "") return command

  // Quoted payload: eval "rm -rf /"  /  cmd /c 'del …'  /  sh -c "…"
  const quoted = /^([A-Za-z0-9_.-]+)(?:\s+\S+?)*?\s+(["'])([\s\S]*)\2\s*$/.exec(trimmed)
  if (quoted) {
    const head = quoted[1]
    const body = quoted[3]
    if (COMMAND_WRAPPERS.has(head.toLowerCase()) || COMMAND_WRAPPERS.has(head.split(/[\\/]/).pop() ?? head)) {
      const inner = unwrapWrapper(body)
      return inner === body ? inner : inner
    }
  }

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return command

  const head = (tokens[0] ?? "").toLowerCase()
  const headBase = head.split(/[\\/]/).pop() ?? head
  if (!COMMAND_WRAPPERS.has(head) && !COMMAND_WRAPPERS.has(headBase)) return command

  // Find the flag that carries the command text (`-c`, `--command`, `/c`, `/k`).
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? ""
    const flag = token.toLowerCase()
    const candidate =
      VALUE_TAKING_FLAGS.has(flag) && tokens[i + 1] !== undefined
        ? (tokens[i + 1] as string)
        : !flag.startsWith("-") && i === 1
          ? token
          : undefined
    if (candidate !== undefined && candidate.trim() !== "") {
      const inner = unwrapWrapper(candidate)
      // Only trust the unwrap when it actually found something executable.
      return inner.trim() === candidate.trim() && !COMMAND_WRAPPERS.has(inner.split(/\s+/)[0]!.toLowerCase())
        ? command
        : inner
    }
  }
  return command
}

/**
 * Split a line into shell-ish tokens, honouring single/double quotes and
 * backslash escapes so `del /f /s "C:\Program Files"` stays one segment.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let hasContent = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    // Backslash only escapes inside double quotes for a small POSIX set. A
    // Windows path is NOT an escape sequence: inside "…", `C:\Users` must keep
    // its backslashes (dropping them turned `C:\Users` into `C:Users`, which
    // then failed to match the very deny rule we are trying to fire).
    if (ch === "\\" && quote === '"' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1] as string)) {
      current += line[i + 1]
      hasContent = true
      i++
      continue
    }
    if (ch === "\\" && quote !== '"' && quote !== "'" && i + 1 < line.length) {
      current += line[i + 1]
      hasContent = true
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      hasContent = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasContent = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(current)
        current = ""
        hasContent = false
      }
      continue
    }
    current += ch
    hasContent = true
  }
  if (hasContent) tokens.push(current)
  return tokens
}

/**
 * Split on shell control operators that start a NEW command. Operators inside
 * quotes or command substitutions are left alone (the `$( … )` body is pulled
 * out separately and segment-analysed on its own).
 */
function splitOnOperators(line: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let depth = 0

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed !== "") segments.push(trimmed)
    current = ""
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string

    // Backslash escapes a character only outside single quotes, and inside
    // double quotes only for the small POSIX set. A Windows path is NOT an
    // escape: `"C:\Users"` must keep its backslashes, or it degenerates to
    // `C:Users` and stops matching the deny rule it should trip.
    const next = line[i + 1]
    if (ch === "\\" && next !== undefined) {
      if (quote === "'") {
        current += ch
        continue
      }
      if (quote === '"' && !'"\\$`\n'.includes(next)) {
        current += ch
        continue
      }
      current += next
      i++
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    // $( … ) and ( … ) substitution: segment the body, keep the wrapper too.
    if (ch === "$" && line[i + 1] === "(") {
      const body = readBalanced(line, i + 1)
      if (body !== null) {
        current += "$("
        flush()
        // The wrapper with its substitution removed is still a command.
        segments.push(unwrapWrapper(stripSubstitutions(current + ")")))
        for (const inner of segmentCommand(body.text)) segments.push(inner)
        current = ""
        i = body.end
        continue
      }
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1)
      if (end !== -1) {
        flush()
        for (const inner of segmentCommand(line.slice(i + 1, end))) segments.push(inner)
        i = end
        continue
      }
    }

    if (ch === "(" || ch === "{") {
      depth++
      current += ch
      continue
    }
    if (ch === ")" || ch === "}") {
      if (depth > 0) depth--
      current += ch
      continue
    }
    if (depth === 0) {
      if (ch === ";" || ch === "\n" || ch === "\r") {
        flush()
        continue
      }
      // && and || are single separators; a lone & (background) or | (pipe)
      // consumes only itself — the loop's own step moves past. (An
      // unconditional skip here ate the character after a spaceless
      // separator: `curl x|sh` lost its `s`, `a&b` lost its `b`.)
      if (ch === "&") {
        flush()
        if (line[i + 1] === "&") i++
        continue
      }
      if (ch === "|") {
        flush()
        if (line[i + 1] === "|") i++
        continue
      }
    }
    current += ch
  }
  flush()
  return segments
}

/** Read a balanced `( … )` body starting at `open`; returns its inner text. */
function readBalanced(line: string, open: number): { text: string; end: number } | null {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = open; i < line.length; i++) {
    const ch = line[i] as string
    if (ch === "\\" && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return { text: line.slice(open + 1, i), end: i }
    }
  }
  return null
}

/** Drop `$( … )` and backtick spans, leaving the surrounding command. */
function stripSubstitutions(line: string): string {
  let out = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (ch === "\\" && quote !== "'") {
      out += line[i + 1] ?? ""
      i++
      continue
    }
    if (quote) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === "$" && line[i + 1] === "(") {
      const body = readBalanced(line, i + 1)
      if (body) {
        out += " "
        i = body.end
        continue
      }
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1)
      if (end !== -1) {
        i = end
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * Split a command line into every sub-command it will execute.
 *
 * Always includes at least one segment; the whole (unparsed) command is
 * returned when nothing could be split, so callers can evaluate unconditionally.
 */
export function segmentCommand(command: string): string[] {
  const trimmed = command.trim()
  if (trimmed === "") return []

  const segments: string[] = []
  const seen = new Set<string>()

  const push = (segment: string) => {
    const value = segment.trim()
    // Drop trivial noise (`echo` with nothing left after substitution removal).
    if (value === "" || value === ")") return
    if (seen.has(value)) return
    seen.add(value)
    segments.push(value)
  }

  for (const part of splitOnOperators(trimmed)) {
    for (const piece of splitOnOperators(part)) push(piece)
    const unwrapped = unwrapWrapper(part)
    if (unwrapped !== part) {
      push(unwrapped)
      for (const inner of splitOnOperators(unwrapped)) push(inner)
    }
  }

  if (segments.length === 0) return [trimmed]
  // The original line is always segment 0's ancestor: include it so a rule
  // written against the full invocation (e.g. "* | sh") still fires.
  push(trimmed)
  return segments
}

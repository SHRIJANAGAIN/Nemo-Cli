/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Model-controlled strings that become a SINGLE path segment (inbox files,
 * rule files, generated-agent profiles) must pass through `safePathSegment`
 * before they are joined onto a directory. Without it a value like
 * `../../.config/evil` walks straight out of the intended directory:
 * `path.join` normalizes `..`, so containment has to be decided on the
 * segment itself, never on the joined result.
 *
 * Returns the segment unchanged when it is safe to use as a file name,
 * `null` when the caller must refuse it.
 */
const WINDOWS_RESERVED_DEVICES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
])

function hasControlChar(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    // C0 controls plus DEL: NUL truncates C-string APIs, newline/CR would
    // break frontmatter or log lines that embed the segment verbatim.
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function safePathSegment(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  if (raw.length === 0 || raw.length > 128) return null
  if (hasControlChar(raw)) return null
  // Both separators are rejected on every platform so behaviour does not
  // change with the host OS (a backslash is legal in a POSIX filename but
  // is a separator on Windows).
  if (raw.includes("/") || raw.includes("\\")) return null
  if (raw === "." || raw === "..") return null
  // Win32 strips trailing dots and spaces: "evil." and "evil" would collide.
  if (/[ .]$/.test(raw)) return null
  // Windows device names open a device instead of a file even with an
  // extension ("CON.md" is still the console).
  const stem = raw.split(".")[0]?.toUpperCase() ?? ""
  if (WINDOWS_RESERVED_DEVICES.has(stem)) return null
  return raw
}

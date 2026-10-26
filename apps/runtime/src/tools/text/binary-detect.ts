/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Binary-file detection and a useful refusal.
 *
 * `readFileSync(p, "utf8")` on a binary file does not throw — it silently
 * replaces every invalid byte with U+FFFD. So pointing `read_file` at a `.docx`,
 * `.xlsx` or `.pdf` returns a screenful of `�`, which is worse than an error:
 *
 *  - it burns context on bytes that carry no information for the model,
 *  - the reply LOOKS like content, so the model reasons about corruption as if
 *    it were the document, and
 *  - nothing in the output says the read was meaningless.
 *
 * The fix is to recognise the format and say what it actually is, so the model
 * can pick a different route instead of retrying the same call. Detection is by
 * MAGIC BYTES, not by extension: a `.docx` that is really a renamed zip, and a
 * `.txt` that is really a PDF, both occur, and an extension lies about content.
 */

/** Bytes sampled from the head. Enough for every magic number below. */
const PROBE_BYTES = 4_096

/** How many U+FFFD in a decoded prefix means "this was never text". */
const REPLACEMENT_THRESHOLD = 0.02

/** Fraction of NUL bytes above which a probe is treated as binary, not text. */
const NUL_RATIO_THRESHOLD = 0.5

/**
 * Detect from an OPEN descriptor, reading only its head.
 *
 * This is the form the read tool must use. Probing by path would open the file a
 * SECOND time, so the bytes inspected could differ from the bytes later read —
 * reopening by path after #121 verified a descriptor is exactly the TOCTOU window
 * that hardening closed. Reading the head off the same descriptor that the
 * verified read will use makes the two views of the file necessarily identical.
 */
export function detectBinaryFd(fd: number, size = 0): BinaryInfo {
  try {
    const buffer = Buffer.alloc(PROBE_BYTES)
    // An explicit position makes this an absolute read that does NOT advance the
    // descriptor's own offset, so the subsequent verified read still starts at
    // byte zero. (There is no `lseekSync` — `readSync`'s position argument is
    // the way to read from a fixed offset.)
    const read = fs.readSync(fd, buffer, 0, PROBE_BYTES, 0)
    return { ...detectBinary(buffer.subarray(0, read)), size }
  } catch {
    return { binary: false }
  }
}

/**
 * Detect from a path, reading only its HEAD.
 *
 * Deliberately not `readFileSync(p)`: this is called from the read tool, which
 * exists because a model once pointed it at a 4 GB log. Loading the whole file
 * to look at its first 4 KB would reintroduce exactly the out-of-memory kill
 * #121 removed. Prefer `detectBinaryFd` where a descriptor already exists.
 */
export function detectBinaryFile(filePath: string): BinaryInfo {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, "r")
    return detectBinaryFd(fd, fs.fstatSync(fd).size)
  } catch {
    // Unreadable: let the caller's own read produce the real error message.
    return { binary: false }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* best effort */
      }
    }
  }
}

export type BinaryFormat =
  | "zip-container"
  | "office-docx"
  | "office-xlsx"
  | "office-pptx"
  | "pdf"
  | "gzip"
  | "png"
  | "jpeg"
  | "gif"
  | "elf"
  | "wasm"
  | "sqlite"
  | "utf16"

export interface BinaryInfo {
  readonly binary: boolean
  /** Present only when `binary` is true. */
  readonly format?: BinaryFormat
  /** Human-readable, action-oriented explanation for the model. */
  readonly reason?: string
  /** What to do instead, so the reply is actionable rather than a dead end. */
  readonly suggestion?: string
  /** Size in bytes when known from the probe. */
  readonly size?: number
}

function startsWith(head: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (head[offset + i] !== bytes[i]) return false
  }
  return true
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]

/**
 * Identify a format from its leading bytes.
 *
 * ZIP is checked by scanning the local file header names rather than trusting
 * the extension, because `.docx`, `.xlsx`, `.pptx` and a plain `.zip` are the
 * same container and only the entries inside tell them apart. That is why the
 * signature list alone cannot answer the question.
 */
function identify(head: Buffer): { format: BinaryFormat; reason: string; suggestion: string } | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) {
    return {
      format: "pdf",
      reason: "PDF document (binary, compressed page streams)",
      suggestion:
        "Read the raw file for its text via a PDF extractor, or ask the user to paste the relevant pages. Do not retry read_file.",
    }
  }
  if (startsWith(head, ZIP)) {
    // Office formats are ZIP containers of XML; the entries are what identify one.
    const probe = head.toString("latin1")
    if (probe.includes("word/")) {
      return {
        format: "office-docx",
        reason: "Word document (.docx) — a ZIP of XML parts, not readable as text",
        suggestion:
          "Use a document extractor, or ask the user to paste the text. The prose is inside word/document.xml.",
      }
    }
    if (probe.includes("xl/")) {
      return {
        format: "office-xlsx",
        reason: "Excel workbook (.xlsx) — a ZIP of XML parts, not readable as text",
        suggestion: "Use a spreadsheet extractor, or ask which sheet and range matters.",
      }
    }
    if (probe.includes("ppt/")) {
      return {
        format: "office-pptx",
        reason: "PowerPoint deck (.pptx) — a ZIP of XML parts, not readable as text",
        suggestion: "Use a presentation extractor, or ask for the slides of interest.",
      }
    }
    return {
      format: "zip-container",
      reason: "ZIP archive (binary)",
      suggestion: "List and extract the entries with a shell tool rather than reading the archive as text.",
    }
  }
  if (startsWith(head, [0x1f, 0x8b])) {
    return { format: "gzip", reason: "gzip-compressed data", suggestion: "Decompress first (`gunzip -c`), then read." }
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) {
    return {
      format: "png",
      reason: "PNG image",
      suggestion: "Use an image-capable read path; alt text or OCR is needed.",
    }
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return { format: "jpeg", reason: "JPEG image", suggestion: "Use an image-capable read path." }
  }
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) {
    return { format: "gif", reason: "GIF image", suggestion: "Use an image-capable read path." }
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) {
    return { format: "elf", reason: "ELF executable", suggestion: "Inspect with a binary tool; this is not source." }
  }
  if (startsWith(head, [0x00, 0x61, 0x73, 0x6d])) {
    return { format: "wasm", reason: "WebAssembly module", suggestion: "Use a wasm-aware tool; this is not source." }
  }
  if (
    startsWith(head, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])
  ) {
    return {
      format: "sqlite",
      reason: "SQLite database",
      suggestion: "Query it with the `sqlite3` shell; do not read it as text.",
    }
  }
  return null
}

/**
 * Decide whether a buffer is text, and if not, what it is.
 *
 * A NUL byte is the reliable signal: no text encoding uses it, and UTF-16 text
 * (which legitimately contains NULs between ASCII pairs) is called out
 * separately rather than being called plain binary.
 */
export function detectBinary(buffer: Buffer): BinaryInfo {
  const probe = buffer.subarray(0, PROBE_BYTES)
  if (probe.length === 0) return { binary: false, size: buffer.length }

  // Magic bytes FIRST. A signature is conclusive; the UTF-16 test below is only a
  // heuristic. Running the heuristic first misreads anything with a NUL at an
  // even or odd offset — which is most binary formats, gzip's `1f 8b 08 00`
  // among them.
  const identified = identify(probe)
  if (identified) return { binary: true, size: buffer.length, ...identified }

  // UTF-16LE/BE: ASCII-range characters alternate with NUL bytes. Needs enough
  // bytes for the parity to mean anything — two bytes cannot be distinguished
  // from a NUL-terminated binary header.
  const hasNul = probe.includes(0)
  if (hasNul && probe.length >= 8) {
    const even = probe.filter((_, i) => i % 2 === 0)
    const odd = probe.filter((_, i) => i % 2 === 1)
    const evenNul = even.reduce((n, b) => (b === 0 ? n + 1 : n), 0)
    const oddNul = odd.reduce((n, b) => (b === 0 ? n + 1 : n), 0)
    // Real UTF-16 ASCII text is NUL on ONE parity class and never on the other,
    // across MANY characters. Requiring the full class (not merely "this parity
    // has a NUL and the other does not") is what stops a single stray NUL in an
    // ordinary UTF-8 file from being read as UTF-16.
    const utf16le = oddNul >= 4 && oddNul >= odd.length - 1 && evenNul === 0
    const utf16be = evenNul >= 4 && evenNul >= even.length - 1 && oddNul === 0
    if (utf16le || utf16be) {
      return {
        binary: true,
        format: "utf16",
        reason: "UTF-16 encoded text",
        suggestion: "Re-encode as UTF-8 before reading, or read it with an encoding-aware tool.",
        size: buffer.length,
      }
    }
  }

  if (hasNul) {
    // Mostly-NUL, not merely contains-NUL. A single stray NUL appears in real
    // text (a truncated UTF-8 char, a binary blob inside a log) and refusing a
    // 1 GB log over one would be worse than reading its prefix. A file whose
    // probe is overwhelmingly NUL has no readable content to return.
    const nulCount = probe.reduce((n, byte) => (byte === 0 ? n + 1 : n), 0)
    if (nulCount / probe.length > NUL_RATIO_THRESHOLD) {
      return {
        binary: true,
        reason: "binary data (predominantly NUL bytes)",
        suggestion: "This is not text; use a format-aware tool.",
        size: buffer.length,
      }
    }
    return { binary: false, size: buffer.length }
  }

  // No magic number and no NUL, but invalid UTF-8 still means binary: decoding
  // produced replacement characters, which is exactly what the reader would hand
  // the model as if it were content.
  const decoded = probe.toString("utf8")
  const replacements = (decoded.match(/�/g) ?? []).length
  if (replacements / Math.max(1, decoded.length) > REPLACEMENT_THRESHOLD) {
    return {
      binary: true,
      reason: "binary data (not valid UTF-8)",
      suggestion: "This is not text; use a format-aware tool.",
      size: buffer.length,
    }
  }
  return { binary: false, size: buffer.length }
}

/**
 * The message to hand back instead of mojibake.
 *
 * Returns null for text, so the caller can keep its normal path. Deliberately
 * names the format and the next action: a refusal that only says "binary file"
 * costs the model a retry loop.
 */
export function binaryReadMessage(info: BinaryInfo, filePath: string): string | null {
  if (!info.binary) return null
  const ext = path.extname(filePath).toLowerCase()
  const name = path.basename(filePath)
  const parts = [`${name} is not text — ${info.reason ?? "binary content"}.`]
  if (ext && !info.format?.startsWith("office") && !info.format) parts.push(`Extension: ${ext}`)
  parts.push(info.suggestion ?? "Use a format-aware tool.")
  parts.push(`(${info.size ?? 0} bytes)`)
  return parts.join(" ")
}

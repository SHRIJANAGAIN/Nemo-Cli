/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"

/**
 * Bounded whole-file reads for the text tools. The standard read tool
 * (file-edit/read-file.ts) reads a bounded prefix; csv/summarize/extract/
 * diff/patch called `readFileSync` on the WHOLE file, so a model pointed at
 * a multi-GB dataset took the CLI down with an OOM (#119).
 */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024

export interface CappedTextFile {
  text: string
  totalBytes: number
  truncated: boolean
}

/** Read at most `maxBytes` from the start of `p`; never buffers more. */
export function readFileTextCapped(p: string, maxBytes: number = MAX_TEXT_FILE_BYTES): CappedTextFile {
  const totalBytes = fs.statSync(p).size
  const fd = fs.openSync(p, "r")
  try {
    const buf = Buffer.alloc(maxBytes + 1)
    const read = fs.readSync(fd, buf, 0, maxBytes + 1, 0)
    const truncated = read > maxBytes
    let text = buf.subarray(0, Math.min(read, maxBytes)).toString("utf8")
    if (truncated) text = text.replace(/�+$/, "")
    return { text, totalBytes, truncated }
  } finally {
    fs.closeSync(fd)
  }
}

/** Read the ENTIRE file or fail — for tools that cannot act on a prefix. */
export function readFileTextExact(p: string, maxBytes: number = MAX_TEXT_FILE_BYTES): string {
  const r = readFileTextCapped(p, maxBytes)
  if (r.truncated) throw new Error(`Refusing to read ${p}: file exceeds the ${maxBytes}-byte cap.`)
  return r.text
}

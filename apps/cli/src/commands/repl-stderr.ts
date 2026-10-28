/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * REPL child stderr forensics.
 *
 * The Ink REPL child used to inherit the console's stderr raw, so a fatal
 * message tore through the TUI frame and scrolled away unlogged — and a fatal
 * message is exactly what a crash produces. Five "Ink REPL exited with code
 * 134" crashes (2026-09-30 → 2026-10-07) stayed undiagnosed for this reason:
 * on this platform `process.abort()` exits 134 while JS heap OOM and uncaught
 * throws exit 1 (measured), so the 134s are native/V8-fatal and their one
 * naming line — `FATAL ERROR: …` — was written to a console nobody kept.
 *
 * This capture keeps the child's live rendering byte-identical (every chunk
 * is tee'd to the launcher's own stderr, which is the same console the
 * child inherited) while retaining a bounded tail in memory. On child exit
 * the tail is appended — redacted through `redactPayload`, the platform's
 * disk-sink chokepoint — to `~/.nemo/logs/repl-stderr.log` with an
 * exit-code header, so a non-zero exit can point straight at the evidence.
 *
 * House rules mirrored from `apps/cli/src/logger.ts`: the file sink honours
 * the same `NEMO_LOG_FILE=off|0` kill switch, rotates at 1 MB to
 * `.old`, and every write is best-effort — capture failure must never crash
 * the CLI. Retention follows the repo's process-output cap (256 KB tail).
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { redactPayload } from "../../../../packages/core/src/secrets.js"

/** In-memory tail cap — the repo's process-output cap (256KB). */
const MAX_CAPTURE_BYTES = 256 * 1024
/** On-disk rotation point — same as nemo.log. */
const MAX_FILE_BYTES = 1024 * 1024

export interface StderrExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface StderrCaptureOptions {
  /** Live sink for every chunk; defaults to this process's own stderr. */
  tee?: (chunk: Buffer) => void
  /** Capture file; defaults to ~/.nemo/logs/repl-stderr.log. `null` disables the disk sink (tee still runs). */
  logPath?: string | null
  /** Retained tail size in bytes; defaults to 256KB. */
  maxBytes?: number
}

export interface StderrCapture {
  /** Tee a child stderr chunk to the live sink and retain it. */
  write(chunk: Buffer | string): void
  /**
   * Append the retained (redacted) tail plus an exit header to the capture
   * file. Returns the file path on success, or `null` when nothing was
   * captured, the sink is disabled, or the write failed. Idempotent.
   */
  finish(exit: StderrExit): string | null
}

/** Same kill switch as nemo.log: NEMO_LOG_FILE=off|0 disables file sinks. */
function defaultLogPath(): string | null {
  const raw = process.env.NEMO_LOG_FILE
  if (raw === "off" || raw === "0") return null
  return path.join(os.homedir(), ".nemo", "logs", "repl-stderr.log")
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size >= MAX_FILE_BYTES) {
      fs.renameSync(file, file + ".old")
    }
  } catch {
    /* best effort */
  }
}

export function createStderrCapture(options: StderrCaptureOptions = {}): StderrCapture {
  const tee = options.tee ?? ((chunk: Buffer) => void process.stderr.write(chunk))
  const logPath = options.logPath === undefined ? defaultLogPath() : options.logPath
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES

  const chunks: Buffer[] = []
  let size = 0
  let finished: string | null = null
  let finishedOnce = false

  return {
    write(chunk: Buffer | string): void {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      if (buf.length === 0) return
      // Live tee is best-effort too — a throwing sink must not escape the
      // child's data handler into the CLI's uncaughtException path.
      try {
        tee(buf)
      } catch {
        /* keep capturing */
      }
      chunks.push(buf)
      size += buf.length
      // Bound memory live: drop whole oldest chunks as the tail outgrows the
      // cap, then hard-trim when a single chunk alone exceeds it (finish()
      // re-slices the exact last maxBytes for what lands on disk).
      while (size > maxBytes && chunks.length > 1) {
        const gone = chunks.shift()
        if (!gone) break
        size -= gone.length
      }
      if (size > maxBytes && chunks.length === 1) {
        const only = chunks[0]
        if (only) {
          chunks[0] = only.subarray(only.length - maxBytes)
          size = maxBytes
        }
      }
    },

    finish(exit: StderrExit): string | null {
      if (finishedOnce) return finished
      finishedOnce = true
      if (chunks.length === 0 || !logPath) return null
      const header = `[${new Date().toISOString()}] repl-stderr exit code=${exit.code} signal=${exit.signal}\n`
      const tail = Buffer.concat(chunks).subarray(-maxBytes).toString("utf8")
      // Disk sink: redact through the single chokepoint (logger.ts rule).
      const payload = redactPayload(header + tail) as string
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        rotate(logPath)
        fs.appendFileSync(logPath, payload + "\n", "utf8")
        finished = logPath
        return finished
      } catch {
        // Capture is diagnostics, never a crash path.
        return null
      }
    },
  }
}

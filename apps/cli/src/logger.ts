/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Structured logging for the CLI.
 *
 * - Console: warn/error go to stderr (debug/info only when TRAYAMBAK_LOG
 *   raises the console threshold).
 * - File: append-only JSON lines to ~/.trayambak/logs/trayambak.log
 *   (override with TRAYAMBAK_LOG_FILE; disable with TRAYAMBAK_LOG_FILE=off),
 *   rotated at 1 MB to .old. Every write is best-effort — logging must
 *   never crash the CLI.
 *
 * Levels: TRAYAMBAK_LOG = debug | info | warn | error | silent
 * (default console threshold "warn"; the file receives every level).
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { redactLogValue } from "../../../packages/core/src/secrets.js"

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
const MAX_FILE_BYTES = 1024 * 1024

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (!raw) return fallback
  const v = raw.toLowerCase()
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent") return v
  return fallback
}

function consoleThreshold(): LogLevel {
  return parseLevel(process.env.TRAYAMBAK_LOG, "warn")
}

function logFilePath(): string | null {
  const raw = process.env.TRAYAMBAK_LOG_FILE
  if (raw === "off" || raw === "0") return null
  if (raw) return raw
  return path.join(os.homedir(), ".trayambak", "logs", "trayambak.log")
}

function rotate(file: string): void {
  try {
    const stat = fs.statSync(file)
    if (stat.size >= MAX_FILE_BYTES) {
      fs.renameSync(file, file + ".old")
    }
  } catch {
    /* best effort */
  }
}

function writeFileLine(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const file = logFilePath()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    rotate(file)
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(fields ?? {}),
    })
    fs.appendFileSync(file, line + "\n", "utf8")
  } catch {
    /* never let logging break the CLI */
  }
}

function emit(level: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>): void {
  // Redact at the single chokepoint: both the JSONL file and stderr go
  // through here, so no log sink can ever see raw credential material.
  const safeMessage = redactLogValue(message) as string
  const safeFields = fields ? (redactLogValue(fields) as Record<string, unknown>) : undefined
  writeFileLine(level, safeMessage, safeFields)
  if (RANK[level] >= RANK[consoleThreshold()]) {
    const suffix = safeFields && Object.keys(safeFields).length ? " " + JSON.stringify(safeFields) : ""
    process.stderr.write(`[${level}] ${safeMessage}${suffix}\n`)
  }
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>): void => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>): void => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>): void => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>): void => emit("error", message, fields),
}

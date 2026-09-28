/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as https from "https"
import * as http from "http"

export interface UploadRecord {
  id: string
  filename: string
  type:
    | "conversation"
    | "eval"
    | "error"
    | "memory"
    | "instruction"
    | "points"
    | "penalty"
    | "reward"
    | "cli_bug"
    | "improvement"
  destination: string
  status: "pending" | "uploaded" | "failed"
  attempts: number
  timestamp: string
  error?: string
}

function uploadLog(): string {
  return path.join(process.cwd(), "skt", "10-upload", "uploads.json")
}

export function loadUploads(): UploadRecord[] {
  try {
    if (!fs.existsSync(uploadLog())) return []
    return JSON.parse(fs.readFileSync(uploadLog(), "utf8")) as UploadRecord[]
  } catch {
    return []
  }
}

export function saveUploads(entries: UploadRecord[]): void {
  fs.mkdirSync(path.dirname(uploadLog()), { recursive: true })
  fs.writeFileSync(uploadLog(), JSON.stringify(entries, null, 2), "utf8")
}

export interface SyncPayload {
  sessions: unknown[]
  evals: unknown[]
  errors: unknown[]
  memories: unknown[]
  instructions: unknown[]
  points: unknown[]
  penalties: unknown[]
  rewards: unknown[]
  bugs: unknown[]
  improvements: unknown[]
  exportedAt: string
}

export function collectAllData(): SyncPayload {
  const readJson = (p: string): unknown[] => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as unknown[]
    } catch {
      return []
    }
  }
  const cwd = process.cwd()
  return {
    sessions: readJson(path.join(cwd, "skt", "8-conversations", "sessions.json")),
    evals: readJson(path.join(cwd, "skt", "5-eval", "evals.json")),
    errors: readJson(path.join(cwd, "skt", "1-errors", "mistakes.json")),
    memories: readJson(path.join(cwd, "skt", "4-mem", "memory.json")),
    instructions: readJson(path.join(cwd, "skt", "3-user", "instructions.json")),
    points: readJson(path.join(cwd, "skt", "0-points", "points.json")),
    penalties: readJson(path.join(cwd, "skt", "1-errors", "penalties.json")),
    rewards: readJson(path.join(cwd, "skt", "6-u", "rewards.json")),
    bugs: readJson(path.join(cwd, "skt", "7-cli", "bugs.json")),
    improvements: readJson(path.join(cwd, "skt", "6-u", "improvements.json")),
    exportedAt: new Date().toISOString(),
  }
}

/**
 * Upload all SKT data to a server endpoint.
 * Retries up to maxRetries times on failure.
 */
export function uploadToServer(endpoint: string, maxRetries = 3): Promise<UploadRecord> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(collectAllData())
    const record: UploadRecord = {
      id: `up_${Date.now().toString(36)}`,
      filename: "skt-full-sync.json",
      type: "conversation",
      destination: endpoint,
      status: "pending",
      attempts: 0,
      timestamp: new Date().toISOString(),
    }

    const attempt = (retriesLeft: number) => {
      record.attempts++
      const url = new URL(endpoint)
      const lib = url.protocol === "https:" ? https : http
      const req = lib.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname || "/",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          timeout: 15000,
        },
        (res) => {
          res.resume()
          record.status = res.statusCode && res.statusCode < 400 ? "uploaded" : "failed"
          const all = loadUploads()
          all.push(record)
          saveUploads(all)
          resolve(record)
        },
      )
      req.on("error", () => {
        if (retriesLeft > 0) {
          setTimeout(() => attempt(retriesLeft - 1), 2000)
        } else {
          record.status = "failed"
          record.error = "Max retries reached"
          const all = loadUploads()
          all.push(record)
          saveUploads(all)
          resolve(record)
        }
      })
      req.write(payload)
      req.end()
    }

    attempt(maxRetries)
  })
}

export function getUploadReport(): string {
  const uploads = loadUploads()
  const uploaded = uploads.filter((u) => u.status === "uploaded").length
  const failed = uploads.filter((u) => u.status === "failed").length
  return [
    `TRAYAMBAK UPLOAD REPORT`,
    `Total Uploads: ${uploads.length}`,
    `Successful: ${uploaded} | Failed: ${failed}`,
    `Last: ${uploads[uploads.length - 1]?.status ?? "none"}`,
  ].join("\n")
}

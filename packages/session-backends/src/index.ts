/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { AgentMessage } from "../../protocol/src/index.js"

/** Pluggable storage for agent session transcripts. */
export interface SessionBackend {
  readonly id: string
  load(): AgentMessage[]
  save(messages: AgentMessage[]): void
  clear(): void
}

export class InMemoryBackend implements SessionBackend {
  readonly id = "memory"
  private messages: AgentMessage[] = []
  load(): AgentMessage[] {
    return this.messages
  }
  save(messages: AgentMessage[]): void {
    this.messages = messages.slice()
  }
  clear(): void {
    this.messages = []
  }
}

export class FileBackend implements SessionBackend {
  readonly id: string
  constructor(private readonly file: string) {
    this.id = `file:${file}`
  }
  load(): AgentMessage[] {
    if (!fs.existsSync(this.file)) return []
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")).messages ?? []
    } catch {
      return []
    }
  }
  save(messages: AgentMessage[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ messages }, null, 2), { encoding: "utf8", mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* best effort */
    }
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* best effort on Windows */
    }
  }
  clear(): void {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file)
  }
}

export function createSessionBackend(file?: string): SessionBackend {
  return file ? new FileBackend(file) : new InMemoryBackend()
}

export * from "./transcript.js"

/* Read side. `transcript.ts` wrote context.jsonl / wire.jsonl but nothing read
 * them back, so a transcript was write-only and resume could not rebuild history
 * from it. */
export {
  DEFAULT_READ_BYTES,
  MAX_TRANSCRIPT_BYTES,
  describeRead,
  isMessageRecord,
  loadContextForResume,
  readContext,
  readContextTail,
  readJsonl,
  readWire,
  type ContextLoad,
  type DetailedReadResult,
  type QuarantinedLine,
  type ReadResult,
  type WireRecord,
} from "./read.js"

/* Retention + integrity: bounded growth and torn-write detection. */
export {
  OVERSIZE_BYTES,
  formatSessionReport,
  previewPrune,
  pruneSessions,
  totalSessionBytes,
  verifySession,
  type PruneOptions,
  type PruneResult,
  type SessionHealth,
  type SessionReport,
} from "./retention.js"

/* Export renderers behind the format the README advertises. */
export {
  exportAll,
  exportFileName,
  exportSession,
  type ExportFormat,
  type ExportOptions,
  type ExportResult,
} from "./export.js"

/* Fork with recorded provenance. */
export {
  forkChain,
  forkSession,
  readProvenance,
  type ForkOptions,
  type ForkProvenance,
  type ForkResult,
} from "./fork.js"

/* Analytics: turn a stored transcript into numbers. The pure analysis lives in
 * packages/core (zero imports) so `apps/cli`, which may only import core and
 * execpolicy, can reach it; only the filesystem half lives here. */
export { readTranscriptStats, readTranscriptStatsText } from "./analytics.js"

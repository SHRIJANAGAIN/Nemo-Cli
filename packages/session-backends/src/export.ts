/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Transcript export: markdown, plain text, and JSON.
 *
 * The README advertises `nemo export [id] --format markdown|json|text`, so
 * the renderers live here behind one honest entry point rather than each caller
 * inventing its own formatting.
 *
 * The rule that matters: **an export must not silently drop history.** When the
 * transcript is truncated or has malformed lines, the rendered output carries a
 * visible notice instead of quietly presenting a partial conversation as the
 * whole thing. An export is the artefact people paste into a bug report, and a
 * partial one reads as the truth.
 */

import { readState, type TranscriptState } from "./transcript.js"
import { loadContextForResume, readWire, type ContextLoad, type WireRecord } from "./read.js"

export type ExportFormat = "markdown" | "text" | "json"

export interface ExportOptions {
  format: ExportFormat
  /** Cap the read; export is bounded like every other transcript read. */
  maxBytes?: number
  /** Include the raw event log alongside the messages. */
  includeWire?: boolean
  now?: () => number
}

export interface ExportResult {
  id: string
  format: ExportFormat
  body: string
  state: TranscriptState | null
  messageCount: number
  /** True when anything was dropped, so the caller can warn. */
  lossy: boolean
  notes: string[]
}

interface MessageLike {
  role: string
  content?: unknown
  toolName?: string
  toolCallId?: string
  isError?: boolean
}

/** Pull display text out of a message's content, whatever shape it took. */
function textOf(message: MessageLike): string {
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content as { type?: string; text?: string; name?: string; arguments?: unknown }[]) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
    else if (part.type === "thinking" && typeof part.text === "string") parts.push(`_(thinking) ${part.text}_`)
    else if (part.type === "toolCall") parts.push(`\`${part.name ?? "tool"}\`(${safeJson(part.arguments)})`)
  }
  return parts.join("\n\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}"
  } catch {
    return "{}"
  }
}

function loadNotes(load: ContextLoad): string[] {
  const notes: string[] = []
  if (load.truncated) notes.push("transcript was larger than the export read cap — this is a partial export")
  if (load.malformed > 0) notes.push(`${load.malformed} malformed line(s) were skipped`)
  if (load.tornTail) notes.push("the final record was a torn write and was skipped")
  if (load.rejected > 0) notes.push(`${load.rejected} non-message record(s) were skipped`)
  return notes
}

/** Export one session. Never throws: a failed export returns an explanatory body. */
export function exportSession(id: string, opts: ExportOptions): ExportResult {
  const state = readState(id)
  const load = loadContextForResume(id, opts.maxBytes)
  const messages = load.messages as MessageLike[]
  const notes = loadNotes(load)

  let wire: WireRecord[] = []
  if (opts.includeWire === true) {
    const wireRead = readWire(id, opts.maxBytes)
    wire = wireRead.records
    if (wireRead.truncated) notes.push("event log was truncated by the export read cap")
    if (wireRead.malformed > 0) notes.push(`${wireRead.malformed} malformed event(s) were skipped`)
  }

  try {
    const body =
      opts.format === "json"
        ? renderJson(id, state, messages, wire, notes)
        : opts.format === "text"
          ? renderText(state, messages, notes)
          : renderMarkdown(state, messages, notes)
    return {
      id,
      format: opts.format,
      body,
      state,
      messageCount: messages.length,
      lossy: notes.length > 0,
      notes,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      id,
      format: opts.format,
      body: `Export failed: ${reason}`,
      state,
      messageCount: messages.length,
      lossy: true,
      notes: [...notes, `export failed: ${reason}`],
    }
  }
}

function heading(state: TranscriptState | null, id: string): string {
  const title = state?.customTitle ?? state?.title ?? "Untitled session"
  return `${title} (${id})`
}

function renderMarkdown(state: TranscriptState | null, messages: MessageLike[], notes: string[]): string {
  const out: string[] = [`# ${heading(state, "")}`.trim(), ""]
  if (state?.workDir !== undefined && state.workDir !== "") out.push(`Working directory: \`${state.workDir}\``, "")
  if (state?.updatedAt !== undefined) {
    out.push(`Last updated: ${new Date(state.updatedAt).toISOString()}`, "")
  }
  if (notes.length > 0) {
    // Fenced so the notice cannot be mistaken for conversation content.
    out.push("> [!WARNING]", "> This export is partial:", ...notes.map((n) => `> - ${n}`), "")
  }
  for (const message of messages) {
    out.push(`## ${message.role}`, "")
    const text = textOf(message)
    out.push(text.length > 0 ? text : "_(no content)_", "")
    if (message.role === "tool") {
      const label = message.toolName ?? "tool"
      out.push(message.isError === true ? `_tool ${label} failed_` : `_tool ${label}_`, "")
    }
  }
  return out.join("\n")
}

function renderText(state: TranscriptState | null, messages: MessageLike[], notes: string[]): string {
  const out: string[] = [heading(state, ""), ""]
  if (notes.length > 0) out.push(`[partial export: ${notes.join("; ")}]`, "")
  for (const message of messages) {
    // A tool row names the tool, so a plain-text export is greppable for which
    // tools ran without cross-referencing the session id.
    const label = message.role === "tool" ? `tool (${message.toolName ?? "?"})` : message.role
    const text = textOf(message)
    out.push(`--- ${label} ---`, text.length > 0 ? text : "(no content)", "")
  }
  return out.join("\n")
}

function renderJson(
  id: string,
  state: TranscriptState | null,
  messages: MessageLike[],
  wire: WireRecord[],
  notes: string[],
): string {
  return JSON.stringify(
    {
      version: 1,
      id,
      state,
      lossy: notes.length > 0,
      notes,
      messages,
      ...(wire.length > 0 ? { wire } : {}),
    },
    null,
    2,
  )
}

/** Every format's output for one session, for callers that want all three. */
export function exportAll(id: string, opts: Omit<ExportOptions, "format"> = {}): ExportResult[] {
  const formats: ExportFormat[] = ["markdown", "text", "json"]
  return formats.map((format) => exportSession(id, { ...opts, format }))
}

/** File name for a download, safe on every platform.
 *
 * Separators are replaced, AND dot-runs are collapsed: keeping `..` inside an
 * otherwise-safe name produces `nemo-.._.._etc_passwd.json`, which no
 * longer traverses — but a filename containing `..` invites a downstream path
 * join to normalise it, so the ambiguity is removed rather than argued about.
 */
export function exportFileName(id: string, format: ExportFormat): string {
  const ext = format === "markdown" ? "md" : format === "text" ? "txt" : "json"
  const safe = id
    .replace(/\.{2,}/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 128)
  return `nemo-${safe.length > 0 ? safe : "session"}.${ext}`
}
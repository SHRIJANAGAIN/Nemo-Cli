/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reading and finishing a task summary.
 *
 * A summary is the merge point: modes may settle at different times, and a
 * resumed task must be able to say exactly what it already has. Status is
 * derived from the records, never asserted by the caller, so a summary can
 * never claim `ok` while a selection is missing.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import * as fs from "fs"
import * as path from "path"
import { walk } from "./tree.js"

/** Read a JSON object, or null when it is absent or malformed. */
export function readJsonFile(file: string): Record<string, unknown> | null {
  let body: string
  try {
    body = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The chosen label, read under either casing the port has written. */
function chosenLabelOf(selection: Record<string, unknown>): string {
  const value = selection.chosenLabel ?? selection.chosen_label
  return typeof value === "string" ? value : ""
}

/**
 * `ok` iff every mode record succeeded, every selection named a winner, and
 * no error is recorded. Anything else is `partial`.
 */
export function finishSummary(summary: Record<string, unknown>): "ok" | "partial" {
  const modes = record(summary.modes)
  const selections = record(summary.selections)
  const names = Object.keys(modes)
  const errors = Array.isArray(summary.errors) ? summary.errors : []
  if (names.length === 0 || errors.length > 0) return "partial"
  for (const mode of names) {
    const modeRecord = record(modes[mode])
    const selection = record(selections[mode])
    if (modeRecord.ok !== true) return "partial"
    if (selection.ok !== true) return "partial"
    if (chosenLabelOf(selection).length === 0) return "partial"
  }
  return "ok"
}

/** One row of a run listing. */
export interface SummaryRow {
  taskId: string
  domain: string
  k: number
  seed: number | null
  status: string
  modes: string[]
  chosen: Record<string, string>
  errors: string[]
  path: string
}

/** Read one summary for display. */
export function readSummary(file: string): SummaryRow | null {
  const raw = readJsonFile(file)
  if (raw === null) return null
  const modes = record(raw.modes)
  const selections = record(raw.selections)
  const chosen: Record<string, string> = {}
  for (const [mode, value] of Object.entries(selections)) {
    const label = chosenLabelOf(record(value))
    if (label.length > 0) chosen[mode] = label
  }
  return {
    taskId: String(raw.task_id ?? ""),
    domain: String(raw.domain ?? ""),
    k: Number(raw.k ?? 0),
    seed: typeof raw.seed === "number" ? raw.seed : null,
    status: String(raw.status ?? "unknown"),
    modes: Object.keys(modes).sort(),
    chosen,
    errors: Array.isArray(raw.errors) ? raw.errors.map((entry) => String(entry)) : [],
    path: file,
  }
}

/** Every task summary under a runs root, newest last. */
export function listSummaries(runsRoot: string): SummaryRow[] {
  const rows: SummaryRow[] = []
  if (!fs.existsSync(runsRoot)) return rows
  for (const file of walk(runsRoot)) {
    if (path.basename(file) !== "summary.json") continue
    const row = readSummary(file)
    if (row !== null) rows.push(row)
  }
  return rows.sort((a, b) => a.taskId.localeCompare(b.taskId))
}

/** Render a one-line status for a summary row. */
export function describeSummary(row: SummaryRow): string {
  const picks = Object.entries(row.chosen)
    .map(([mode, label]) => `${mode}=${label}`)
    .join(" ")
  return `${row.status.padEnd(10)} ${row.taskId}${picks ? `  ${picks}` : ""}${
    row.errors.length > 0 ? `  errors=${row.errors.length}` : ""
  }`
}

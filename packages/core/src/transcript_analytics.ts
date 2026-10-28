/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Transcript analytics: turn a stored session into numbers.
 *
 * The gap this closes: `cost_tracker` knows what a turn cost, but only while
 * the process is alive. `AssistantMessage` has no `usage` field, so nothing
 * writes provider-reported token counts to disk — a session's cost cannot be
 * reconstructed after it ends. `/stats` therefore answered "how much have I
 * spent" with data that vanished when the CLI exited.
 *
 * So this module works from what IS persisted: message roles, tool calls, stop
 * reasons, content sizes, and envelope timestamps. Token counts are ESTIMATED
 * (chars/4, the same convention the rest of the repo uses) and every estimate
 * is labelled as one. Claiming a precise number the transcript cannot support
 * would be worse than the gap: a wrong cost figure is acted upon, a missing one
 * is noticed.
 *
 * Three properties worth stating because each is a way this is easy to get
 * wrong:
 *
 *  1. **A malformed transcript never throws.** Records come from a JSONL file
 *     that a crashed process may have truncated mid-line. Analytics is a
 *     reporting path; it must not become the thing that fails a `/stats`.
 *  2. **Timestamps are treated as unknown unless present.** A transcript with no
 *     `t` envelope must produce timing stats that say "unknown", not zeros that
 *     read as "instant".
 *  3. **Tool errors are counted separately from tool results.** A tool that ran
 *     and failed is a different signal from one that ran and succeeded, and
 *     averaging them hides both.
 */

/** A message as it comes off disk: unknown, because it was written by an older
 *  build and by whatever the model emitted. */
export type TranscriptRecord = Record<string, unknown>

export interface ToolStat {
  name: string
  /** Times this tool was called. */
  calls: number
  /** Calls that came back with isError. */
  errors: number
  /** Combined characters of every result. A proxy for cost and noise. */
  resultChars: number
}

export interface TurnTiming {
  /** Character offset of the user message that began this turn. */
  startedAtIndex: number
  /** Envelope timestamps bounding the turn, when present. */
  startedAtMs?: number
  endedAtMs?: number
  /** assistant messages in this turn. */
  assistantMessages: number
  /** tool calls issued in this turn. */
  toolCalls: number
  durationMs?: number
  /** How the turn ended, from the last assistant message. */
  endReason?: string
}

export interface TranscriptStats {
  /** Total records inspected, including ones that were skipped. */
  records: number
  /** Records that could not be understood. Surfaced rather than hidden. */
  skipped: number

  userMessages: number
  assistantMessages: number
  toolResultMessages: number
  systemMessages: number

  /** User messages that started a turn. A user message mid-turn is a steer. */
  turns: number
  /** assistant messages that stopped because they wanted a tool. */
  toolUseTurns: number
  /** assistant messages that stopped for any non-tool reason. */
  finalTurns: number
  /** assistant messages that hit the length cap. Worth surfacing loudly. */
  lengthCapped: number
  /** assistant messages that ended in an error. */
  erroredTurns: number

  toolCalls: number
  toolErrors: number
  /** Per-tool breakdown, most-called first. */
  tools: ToolStat[]

  /** Sum of chars/4 over all message content. ESTIMATE, never exact. */
  estimatedInputTokens: number
  estimatedOutputTokens: number

  /** Wall-clock span between the first and last envelope timestamp, when both
   *  exist. Undefined otherwise — never 0, which would read as "instant". */
  spanMs?: number
  /** Turns with a complete pair of timestamps. */
  timedTurns: number
  /** Per-turn breakdown, in transcript order. */
  turnTimings: TurnTiming[]
}

const CHARS_PER_TOKEN = 4

/**
 * Count only content that actually reaches the model.
 *
 * Tool RESULTS are excluded from the output estimate: they are supplied back to
 * the model but are not model output, and folding them in would make a turn that
 * grepped a large file look like the model had written a large file.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function isRecord(value: unknown): value is TranscriptRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function roleOf(record: TranscriptRecord): string | undefined {
  const role = record.role
  return typeof role === "string" ? role : undefined
}

/** Envelope timestamp, accepted as a number or a numeric string. */
function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Flatten a content field to plain text.
 *
 * Content is a union: a string for system/user messages, and an array of parts
 * for assistant messages. Both shapes occur, sometimes in the same transcript
 * across build versions, so both are handled rather than one being assumed.
 *
 * Tool-call arguments are NOT counted. They are structured data the model
 * emitted, and counting their JSON inflates the output estimate by an amount
 * that has nothing to do with how much it wrote.
 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  let out = ""
  for (const part of content) {
    if (typeof part === "string") {
      out += part
      continue
    }
    if (!isRecord(part)) continue
    const type = part.type
    if (type === "text" && typeof part.text === "string") {
      out += part.text
      continue
    }
    // Thinking parts count: they were generated and they were billed.
    if (type === "thinking" && typeof part.thinking === "string") out += part.thinking
  }
  return out
}

/** Tool-call parts on an assistant message, in order. */
function toolCallsOf(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) return []
  const calls: Array<{ id: string; name: string }> = []
  for (const part of content) {
    if (!isRecord(part) || part.type !== "toolCall") continue
    calls.push({
      // A tool call with no id cannot be matched to its result, which is exactly
      // the kind of malformed record a crashed process leaves behind.
      id: typeof part.id === "string" ? part.id : "",
      name: typeof part.name === "string" ? part.name : "(unnamed)",
    })
  }
  return calls
}

/**
 * Analyse a transcript.
 *
 * `records` is `readonly unknown[]` rather than a message type because this
 * runs on data read back from disk by an earlier build of this program. Typing
 * it as `AgentMessage[]` would assert a guarantee the file cannot make.
 */
export function analyzeTranscript(records: readonly unknown[]): TranscriptStats {
  const stats: TranscriptStats = {
    records: records.length,
    skipped: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResultMessages: 0,
    systemMessages: 0,
    turns: 0,
    toolUseTurns: 0,
    finalTurns: 0,
    lengthCapped: 0,
    erroredTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    tools: [],
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    timedTurns: 0,
    turnTimings: [],
  }

  const toolIndex = new Map<string, ToolStat>()
  let firstMs: number | undefined
  let lastMs: number | undefined

  // The turn currently being accumulated. A turn starts at a user message and
  // runs until the next one.
  let current: TurnTiming | undefined
  let currentStartedMs: number | undefined
  let currentLastMs: number | undefined

  const endTurn = (): void => {
    if (current === undefined) return
    if (currentStartedMs !== undefined && currentLastMs !== undefined) {
      current.durationMs = Math.max(0, currentLastMs - currentStartedMs)
      stats.timedTurns += 1
    }
    stats.turnTimings.push(current)
    current = undefined
    currentStartedMs = undefined
    currentLastMs = undefined
  }

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!isRecord(record)) {
      stats.skipped += 1
      continue
    }

    const role = roleOf(record)
    if (role === undefined) {
      stats.skipped += 1
      continue
    }

    const at = timeOf(record.t)
    if (at !== undefined) {
      if (firstMs === undefined || at < firstMs) firstMs = at
      if (lastMs === undefined || at > lastMs) lastMs = at
    }

    switch (role) {
      case "system": {
        stats.systemMessages += 1
        break
      }

      case "user": {
        // A user message both STARTS a turn and, mid-run, steers an existing one.
        // A steer is not a new turn, so it must not inflate the turn count.
        if (current !== undefined) endTurn()
        current = { startedAtIndex: index, assistantMessages: 0, toolCalls: 0 }
        if (at !== undefined) currentStartedMs = at
        stats.userMessages += 1
        stats.turns += 1
        stats.estimatedInputTokens += estimateTokens(textOfContent(record.content))
        break
      }

      case "assistant": {
        if (current === undefined) {
          // An assistant message with no preceding user message: a resume that
          // restored context without the prompt, or a truncated file. Counted as
          // a turn so it is visible rather than silently absorbed.
          current = { startedAtIndex: index, assistantMessages: 0, toolCalls: 0 }
          if (at !== undefined) currentStartedMs = at
          stats.turns += 1
        }
        current.assistantMessages += 1
        stats.assistantMessages += 1
        if (at !== undefined) currentLastMs = at

        const text = textOfContent(record.content)
        stats.estimatedOutputTokens += estimateTokens(text)

        const calls = toolCallsOf(record.content)
        current.toolCalls += calls.length
        stats.toolCalls += calls.length
        for (const call of calls) {
          const existing = toolIndex.get(call.name)
          if (existing === undefined) {
            toolIndex.set(call.name, { name: call.name, calls: 1, errors: 0, resultChars: 0 })
          } else {
            existing.calls += 1
          }
        }

        switch (record.stopReason) {
          case "tool_use":
            stats.toolUseTurns += 1
            break
          case "length":
            stats.lengthCapped += 1
            stats.finalTurns += 1
            break
          case "error":
            stats.erroredTurns += 1
            stats.finalTurns += 1
            break
          case "aborted":
            stats.finalTurns += 1
            break
          case "end_turn":
          default:
            stats.finalTurns += 1
            break
        }
        if (current.endReason === undefined) current.endReason = typeof record.stopReason === "string" ? record.stopReason : "unknown"
        break
      }

      case "tool": {
        const text = textOfContent(record.content)
        const name = typeof record.toolName === "string" ? record.toolName : "(unnamed)"
        const stat = toolIndex.get(name)
        if (stat !== undefined) {
          stat.resultChars += text.length
          if (record.isError === true) stat.errors += 1
        }
        stats.toolResultMessages += 1
        if (record.isError === true) stats.toolErrors += 1
        // Tool results are prompt input on the NEXT model call, so they count as
        // input rather than output.
        stats.estimatedInputTokens += estimateTokens(text)
        break
      }

      default: {
        stats.skipped += 1
        break
      }
    }
  }

  endTurn()

  // Sorted most-called first, then by error count so a frequently-failing tool
  // outranks a rarely-used clean one, then by name for a stable order.
  stats.tools = [...toolIndex.values()].sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls
    if (b.errors !== a.errors) return b.errors - a.errors
    return a.name.localeCompare(b.name)
  })

  if (firstMs !== undefined && lastMs !== undefined && lastMs >= firstMs) {
    stats.spanMs = lastMs - firstMs
  }

  return stats
}

/**
 * Render stats as lines for a terminal.
 *
 * Every number that is an estimate says so. A user comparing two sessions needs
 * to know whether a difference is real or is two different prompts, and a bare
 * integer invites the wrong conclusion.
 */
export function formatTranscriptStats(stats: TranscriptStats): string {
  const lines: string[] = []
  const pct = (n: number, total: number): string => (total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`)

  lines.push(`records: ${stats.records}${stats.skipped > 0 ? ` (${stats.skipped} unreadable)` : ""}`)
  lines.push(`turns: ${stats.turns}  (${stats.timedTurns} timed)`)
  lines.push(
    `messages: ${stats.userMessages} user, ${stats.assistantMessages} assistant, ` +
      `${stats.toolResultMessages} tool result, ${stats.systemMessages} system`,
  )

  if (stats.spanMs !== undefined) {
    lines.push(`span: ${formatDuration(stats.spanMs)}`)
  } else {
    // Not "0ms": an absent timestamp is missing data, not an instant session.
    lines.push("span: unknown (no timestamps in transcript)")
  }

  if (stats.toolCalls > 0) {
    const top = stats.tools[0]
    lines.push(`tool calls: ${stats.toolCalls} across ${stats.tools.length} tool(s)`)
    if (top !== undefined && top.calls > 0) {
      lines.push(`most used: ${top.name} (${pct(top.calls, stats.toolCalls)})`)
    }
    for (const tool of stats.tools.slice(0, 8)) {
      const flag = tool.errors > 0 ? `, ${tool.errors} error${tool.errors === 1 ? "" : "s"}` : ""
      lines.push(`  ${tool.name}: ${tool.calls} call${tool.calls === 1 ? "" : "s"}${flag}`)
    }
    if (stats.tools.length > 8) lines.push(`  …and ${stats.tools.length - 8} more`)
  }

  if (stats.erroredTurns > 0) lines.push(`errored turns: ${stats.erroredTurns}`)
  if (stats.lengthCapped > 0) {
    // Called out separately: a length-capped turn means the model was cut off
    // mid-answer, which reads as a complete answer in the transcript.
    lines.push(`length-capped turns: ${stats.lengthCapped} (answer was truncated)`)
  }

  lines.push(
    `tokens (estimated): ~${stats.estimatedInputTokens} in, ~${stats.estimatedOutputTokens} out` +
      ` — transcript stores no provider-reported usage`,
  )

  return lines.join("\n")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes - hours * 60}m`
}
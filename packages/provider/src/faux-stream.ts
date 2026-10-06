/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Deterministic faux stream builder for model-free testing.
 *
 * Produces a `streamFn` that returns pre-recorded response events
 * in sequence, so tests can drive the agent loop without any
 * network call. Inspired by pi's test/test-harness.ts.
 */

import { stopReasonFromWire } from "../../protocol/src/index.js"

export interface FauxDelta {
  type:
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "text_start"
    | "text_delta"
    | "text_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | "done"
    | "error"
  text?: string
  toolCallId?: string
  toolName?: string
  stopReason?: string
  usage?: { input: number; output: number }
}

export interface FauxResponse {
  text?: string
  thinking?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  stopReason?: string
  usage?: { input: number; output: number }
  delayMs?: number
}

/** Split text into small chunks to simulate streaming. */
function chunkString(s: string, size = 4): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

/**
 * Build a deterministic stream function from an array of responses.
 * Each call to the returned function yields the next response's
 * deltas, then ends. After all responses are consumed, yields DONE.
 */
export function createFauxStreamFn(responses: FauxResponse[]) {
  let index = 0

  return async function* streamFn() {
    while (index < responses.length) {
      const resp = responses[index++]
      if (resp.delayMs) await new Promise((r) => setTimeout(r, resp.delayMs))

      if (resp.thinking) {
        yield { type: "thinking_start" as const }
        for (const chunk of chunkString(resp.thinking)) {
          yield { type: "thinking_delta" as const, text: chunk }
        }
        yield { type: "thinking_end" as const }
      }

      if (resp.text) {
        yield { type: "text_start" as const }
        for (const chunk of chunkString(resp.text)) {
          yield { type: "text_delta" as const, text: chunk }
        }
        yield { type: "text_end" as const }
      }

      if (resp.toolCalls) {
        for (const tc of resp.toolCalls) {
          const tcId = `faux_tc_${index}`
          yield { type: "toolcall_start" as const, toolCallId: tcId, toolName: tc.name }
          yield { type: "toolcall_delta" as const, toolCallId: tcId, text: JSON.stringify(tc.args) }
          yield { type: "toolcall_end" as const, toolCallId: tcId }
        }
      }

      yield {
        type: "done" as const,
        // Normalised, not passed through: a scripted `"length"` and a
        // gateway's `"MAX_TOKENS"` must both reach the loop as the protocol's
        // `"length"`, or the loop cannot tell a severed answer from a finished
        // one. See protocol/stop-reason.ts.
        stopReason: stopReasonFromWire(resp.stopReason),
        usage: resp.usage,
      }
    }
    yield { type: "done" as const, stopReason: "stop" }
  }
}

/** Build a deterministic usage object. */
export function buildUsage(input = 100, output = 50): { input: number; output: number } {
  return { input, output }
}

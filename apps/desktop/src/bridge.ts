/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Desktop app agent bridge: drives one `Agent` per workspace and streams
 * normalized {@link BridgeEvent}s to the UI. Kept free of `electron`
 * imports so the whole contract (streaming, single-flight, cancel-abort,
 * workspace switches) is unit-testable without a browser or a window —
 * `main.ts` only wires these deps to IPC and the real runtime.
 */

/** Normalized events the renderer understands (mapped from AgentEvent). */
export type BridgeEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; isError: boolean; output: string }
  | { type: "error"; message: string }
  | { type: "done"; stopReason: "end_turn" | "cancelled" | "error" }

/** Structural view of `Agent` — just what the bridge calls. */
export interface BridgeAgent {
  run(prompt: string, emit: (event: unknown) => void, signal?: AbortSignal): Promise<unknown>
}

export interface BridgeDeps {
  /** Creates the agent for a workspace cwd (called lazily, cached per cwd). */
  createAgent(cwd: string): Promise<BridgeAgent>
  onEvent(event: BridgeEvent): void
}

export interface AgentBridge {
  /** Point the bridge at a directory; drops the cached agent if cwd changed. */
  setWorkspace(cwd: string): void
  workspace(): string
  busy(): boolean
  /** Streams events through `onEvent`; resolves when the run is over. */
  send(prompt: string): Promise<void>
  /** Aborts the in-flight run (no-op when idle). */
  cancel(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Plain text of a ToolResult-shaped value (verbatim, never markdown). */
function toolOutput(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return ""
  return result.content
    .filter((part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
}

export function createAgentBridge(deps: BridgeDeps): AgentBridge {
  let workspace = "."
  let agent: BridgeAgent | null = null
  let agentWorkspace: string | null = null
  let controller: AbortController | null = null
  // `inFlight` flips synchronously in send() — a run being *prepared*
  // (agent creation still pending) must already count as busy, or a
  // second prompt slips in and cancel() has nothing to see. It also
  // covers the window where cancel lands before the controller exists.
  let inFlight = false
  let cancelRequested = false
  // The assistant's last message_end stopReason drives the terminal
  // `done` event (mirrors the ACP reply mapping).
  let lastStopReason = "end_turn"

  const ensureAgent = async (): Promise<BridgeAgent> => {
    if (agent !== null && agentWorkspace === workspace) return agent
    const created = await deps.createAgent(workspace)
    agent = created
    agentWorkspace = workspace
    return created
  }

  const forward = (event: unknown): void => {
    if (!isRecord(event) || typeof event.type !== "string") return
    switch (event.type) {
      case "message_update": {
        const delta = isRecord(event.delta) ? event.delta : {}
        if (typeof delta.text === "string" && delta.text.length > 0) {
          deps.onEvent({ type: "text", text: delta.text })
        }
        if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
          deps.onEvent({ type: "thinking", text: delta.thinking })
        }
        return
      }
      case "thinking":
        if (typeof event.thinking === "string" && event.thinking.length > 0) {
          deps.onEvent({ type: "thinking", text: event.thinking })
        }
        return
      case "tool_execution_start":
        if (typeof event.toolCallId === "string") {
          deps.onEvent({
            type: "tool_start",
            id: event.toolCallId,
            name: typeof event.toolName === "string" ? event.toolName : "tool",
          })
        }
        return
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") {
          deps.onEvent({
            type: "tool_end",
            id: event.toolCallId,
            name: typeof event.toolName === "string" ? event.toolName : "tool",
            isError: event.isError === true,
            output: toolOutput(event.result),
          })
        }
        return
      case "message_end": {
        const msg = isRecord(event.message) ? event.message : undefined
        if (msg === undefined) return
        if (typeof msg.stopReason === "string") lastStopReason = msg.stopReason
        // Error messages arrive as one message_end and never stream as
        // chunks — forward their text so the UI shows why the run failed.
        if (msg.stopReason !== "error" || !Array.isArray(msg.content)) return
        const text = msg.content
          .filter((part): part is { type: "text"; text: string } =>
            isRecord(part) && part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
        if (text.length > 0) deps.onEvent({ type: "text", text })
        return
      }
      default:
        return
    }
  }

  return {
    setWorkspace(cwd: string): void {
      if (cwd === workspace) return
      workspace = cwd
      agent = null
      agentWorkspace = null
    },
    workspace(): string {
      return workspace
    },
    busy(): boolean {
      return inFlight
    },
    cancel(): void {
      cancelRequested = true
      controller?.abort()
    },
    async send(prompt: string): Promise<void> {
      if (prompt.trim().length === 0) throw new Error("empty prompt")
      // Checked and claimed synchronously: `inFlight` is set before the
      // first await, so a racing second send always sees it.
      if (inFlight) throw new Error("a run is already in flight")
      inFlight = true
      cancelRequested = false
      let own: AbortController | null = null
      try {
        const run = await ensureAgent()
        own = new AbortController()
        controller = own
        // Cancel landed while the agent was still being created: honor
        // it before a single token is spent.
        if (cancelRequested) own.abort()
        lastStopReason = "end_turn"
        await run.run(prompt, forward, own.signal)
        const stop: "end_turn" | "cancelled" | "error" = own.signal.aborted
          ? "cancelled"
          : lastStopReason === "aborted"
            ? "cancelled"
            : lastStopReason === "error"
              ? "error"
              : "end_turn"
        deps.onEvent({ type: "done", stopReason: stop })
      } catch (err) {
        if (own?.signal.aborted === true) {
          deps.onEvent({ type: "done", stopReason: "cancelled" })
        } else {
          deps.onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) })
          deps.onEvent({ type: "done", stopReason: "error" })
        }
      } finally {
        if (controller === own) controller = null
        inFlight = false
      }
    },
  }
}

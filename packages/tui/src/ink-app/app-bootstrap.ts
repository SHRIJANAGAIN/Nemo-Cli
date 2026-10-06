/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// Bootstrap helpers for TrayambakApp: env-gated input tracing, bracketed-paste
// enable/disable, agent-config defaults, transcript -> AgentMessage conversion, and
// the terminal ROWS hook. Split out of App.tsx so they are unit-testable without
// mounting the component (see app-bootstrap.test.ts).
import { useEffect, useState } from "react"
import { useStdout } from "ink"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TrayambakConfig } from "../../../../apps/runtime/src/config.js"
import type { AgentMessage } from "../../../protocol/src/index.js"
import type { PermissionMode, TrayambakMessage } from "./types.js"

/** Env-gated input tracer (TRAYAMBAK_DEBUG_INPUT=1): records exact stdin
 * bytes, key flags, and raw/tty state per keystroke to trayambak-input.log. */
export const debugInputLog = (line: string): void => {
  if (process.env.TRAYAMBAK_DEBUG_INPUT !== "1") return
  try {
    appendFileSync(join(tmpdir(), "trayambak-input.log"), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* debug only */
  }
}

export function enableBracketedPaste(): () => void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h")
    return () => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004l")
      }
    }
  }
  return () => {}
}

export interface TrayambakAppProps {
  config?: Partial<TrayambakConfig>
  modelName?: string
  permissionMode?: PermissionMode
  onExit?: () => void
  initialPrompt?: string
}

export function createAgentConfig(partial: Partial<TrayambakConfig>): TrayambakConfig {
  return {
    baseUrl: partial.baseUrl ?? "http://localhost:8080",
    model: partial.model ?? "trayambak",
    apiKey: partial.apiKey ?? "",
    // Provider must pass through: dropping it silently rebuilds every agent
    // as NVIDIA (Agent defaults provider ?? "nvidia") — observed live as an
    // HF login (router baseUrl + HF key + Llama model) failing with
    // "NVIDIA API returned 401".
    ...(partial.provider ? { provider: partial.provider } : {}),
    ...(partial.reasoningEffort ? { reasoningEffort: partial.reasoningEffort } : {}),
    cwd: partial.cwd ?? process.cwd(),
    temperature: partial.temperature ?? 0.7,
    topP: partial.topP ?? 0.9,
    maxTokens: partial.maxTokens ?? 4096,
    timeoutMs: partial.timeoutMs ?? 600_000,
    shellCommand: partial.shellCommand ?? "bash -c",
    maxOutputLines: partial.maxOutputLines ?? 2000,
    maxOutputBytes: partial.maxOutputBytes ?? 256 * 1024,
    maxTurns: partial.maxTurns ?? 64,
    // Session budget must survive the rebuild: dropping it here deactivated
    // every configured/env budget in TUI sessions — the loop only applies
    // run.config.budget, so a set cap went silently unenforced (#64).
    ...(partial.budget !== undefined ? { budget: partial.budget } : {}),
    maxToolCalls: partial.maxToolCalls ?? 100,
    maxDistinctToolCalls: partial.maxDistinctToolCalls ?? 1000,
    toolCallRate: partial.toolCallRate ?? 2,
    maxRetries: partial.maxRetries ?? 2,
    retryDelayMs: partial.retryDelayMs ?? 750,
    maxParallelToolCalls: partial.maxParallelToolCalls ?? 4,
    nativeTools: partial.nativeTools ?? true,
    toolsets: partial?.toolsets?.defaults?.length
      ? partial.toolsets
      : { defaults: ["core", "agentic", "ops", "tasks", "mcp", "skills"], disabled: [], platform: {} },
    ...(partial.permissions ? { permissions: partial.permissions } : {}),
    // Developer mode must survive the agent-config rebuild: dropping it here
    // rebuilt every fresh session with the engine default (enabled:false), so
    // a saved /devmode ON (and the gate flag) never reached the model after
    // a restart.
    ...(partial.developerMode ? { developerMode: partial.developerMode } : {}),
    // Operator identity must survive the rebuild too: dropping githubLogin
    // here rebuilt every fresh session's agent as logged-out — /github
    // login worked, TUI restarted, and the ## OPERATOR block still read
    // "not logged in", so the agent never knew its principal. License key
    // + server URL ride along for the same reason (operator-block license
    // line). Display values only — secrets never reach the prompt.
    ...(partial.githubLogin ? { githubLogin: partial.githubLogin } : {}),
    ...(partial.licenseKey ? { licenseKey: partial.licenseKey } : {}),
    ...(partial.licenseServerUrl ? { licenseServerUrl: partial.licenseServerUrl } : {}),
    // MCP servers + skills dir must survive the rebuild too: dropping
    // mcpServers rebuilt every agent with zero MCP tools even when servers
    // were configured (observed live: /mcp dead, mcp__* never reached the
    // model). Same drop class as provider/developerMode above.
    ...(partial.mcpServers ? { mcpServers: partial.mcpServers } : {}),
    ...(partial.skillsDir ? { skillsDir: partial.skillsDir } : {}),
  }
}

export function convertToAgentMessages(msgs: TrayambakMessage[]): AgentMessage[] {
  const result: AgentMessage[] = []
  for (const msg of msgs) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content ?? "" })
    } else if (msg.role === "user") {
      result.push({ role: "user", content: msg.content ?? "" })
    } else if (msg.role === "assistant") {
      if (msg.toolCallId && msg.toolName) {
        // UI tool-call row: rebuild the toolCall part + its result so the
        // model keeps tool context across turns. Was: args JSON replayed as
        // fake assistant prose, result dropped entirely — every turn the
        // model lost all tool outputs.
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(msg.content ?? "{}")
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          } else {
            args = { value: parsed }
          }
        } catch {
          args = { value: msg.content ?? "" }
        }
        result.push({
          role: "assistant",
          content: [{ type: "toolCall", id: msg.toolCallId, name: msg.toolName, arguments: args }],
          stopReason: "tool_use",
        })
        if (msg.result !== undefined) {
          result.push({
            role: "tool",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            content: [{ type: "text", text: msg.result }],
            isError: msg.isError ?? false,
          })
        }
      } else {
        // Thinking rides along: dropping it (old code) lost reasoning
        // context on every history rebuild (compact/retry/queue).
        const parts: Array<{ type: "text"; text: string } | { type: "thinking"; text: string }> = []
        if (msg.thinking) parts.push({ type: "thinking", text: msg.thinking })
        parts.push({ type: "text", text: msg.content ?? "" })
        result.push({
          role: "assistant",
          content: parts,
          stopReason: "end_turn",
        })
      }
    } else if (msg.role === "tool") {
      if (msg.toolCallId && msg.toolName) {
        result.push({
          role: "tool",
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          content: [{ type: "text", text: msg.content ?? "" }],
          isError: msg.isError ?? false,
        })
      }
    }
  }
  return result
}

/**
 * Terminal ROWS for the root Box's fixed height (height={rows}) — the fix
 * for "width grows on resize but the frame never grows downward": Ink only
 * setWidth()s the root, so height="100%" resolved against nothing and the
 * frame hugged content instead of reaching the terminal bottom.
 *
 * Deliberately NOT ink's useWindowSize(): that hook also re-sets state on
 * COLUMN changes, re-rendering the whole tree after a width resize — a
 * second full-frame paint right behind resize-guard's blank+repaint and
 * Ink's own resized() write (smoke-resize-guard counts Welcome frames and
 * saw 2 instead of 1). Width re-flow is owned by the guard + Ink; React
 * only has to follow ROWS so the root Box grows/shrinks downward.
 */
export const useTerminalRows = (): number => {
  const { stdout } = useStdout()
  const [rows, setRows] = useState<number>(() => stdout?.rows || process.stdout?.rows || 24)
  useEffect(() => {
    if (!stdout) return undefined
    const onResize = (): void => {
      // 0/undefined rows (console reattach) → same fallback as ink's
      // getWindowSize truthy check, never height={0}.
      const next = stdout.rows || process.stdout?.rows || 24
      setRows((prev) => (prev === next ? prev : next))
    }
    stdout.on("resize", onResize)
    return () => {
      stdout.removeListener("resize", onResize)
    }
  }, [stdout])
  return rows
}

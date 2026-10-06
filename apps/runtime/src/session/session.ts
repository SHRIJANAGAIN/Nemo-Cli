/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { isRemoteUncPath } from "../config.js"
import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../../../../packages/protocol/src/index.js"
import { toolResultImages } from "../../../../packages/protocol/src/index.js"
import type { WireMessage, WireToolCall } from "../../../../packages/provider/src/index.js"

/** Refuse to read back a session file larger than this. */
const MAX_SESSION_FILE_BYTES = 512 * 1024 * 1024

/** Cap on messages restored from disk, so a huge array cannot exhaust memory. */
const MAX_RESTORED_MESSAGES = 100_000

/** Roles that `AgentMessage` actually admits. */
const RESTORABLE_ROLES = new Set(["system", "user", "assistant", "tool"])

/**
 * Keep only entries shaped like a restorable message.
 *
 * `payload.messages` came out of a user-writable JSON file with no validation,
 * and the old code did `push(...(payload.messages ?? []))` — which spreads
 * whatever is actually there. A string became one message per CHARACTER; a
 * non-iterable object threw, and the catch swallowed it and reported "no
 * session", silently discarding the whole transcript. Anything not carrying a
 * valid role is dropped rather than allowed to reach `toWire()` and a provider.
 */
function sanitizeRestoredMessages(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return []
  const out: AgentMessage[] = []
  for (const entry of raw.slice(0, MAX_RESTORED_MESSAGES)) {
    if (!entry || typeof entry !== "object") continue
    const role = (entry as { role?: unknown }).role
    if (typeof role === "string" && RESTORABLE_ROLES.has(role)) out.push(entry as AgentMessage)
  }
  return out
}

export class Session {
  readonly messages: AgentMessage[] = []
  private systemPrompt = ""

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
  }
  get systemContext(): string {
    return this.systemPrompt
  }

  add(message: AgentMessage): void {
    this.messages.push(message)
  }

  get last(): AgentMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  /** Keep the most recent `keep` turns and drop older assistant/tool history. */
  compact(keep: number): void {
    if (this.messages.length <= keep) return
    const recent = this.messages.slice(-keep)
    this.messages.length = 0
    this.messages.push(...recent)
  }

  clear(): void {
    this.messages.length = 0
  }

  appendToAssistant(content: AssistantMessage["content"][number]): void {
    const last = this.last
    if (last && last.role === "assistant") {
      last.content.push(content)
    } else {
      this.messages.push({ role: "assistant", content: [content], stopReason: "end_turn" })
    }
  }

  toWireMessages(): WireMessage[] {
    const out: WireMessage[] = []
    if (this.systemPrompt) out.push({ role: "system", content: this.systemPrompt })
    for (const m of this.messages) {
      out.push(toWire(m))
      // No OpenAI-compatible endpoint accepts an image part on a `role: "tool"`
      // row, so a tool that returned a picture (view_image, web_fetch on an
      // image URL, an MCP screenshot) re-surfaces it as a user turn placed
      // immediately after its own tool response. Tool-call pairing stays
      // intact: every assistant `tool_calls` id is still answered by its
      // `role: "tool"` row before any user row appears.
      if (m.role === "tool") {
        const images = toolResultImages(m)
        if (images.length > 0) {
          out.push({
            role: "user",
            content: `[image returned by ${m.toolName}]`,
            images,
          })
        }
      }
    }
    return out
  }

  /**
   * Persist conversation history — and deliberately NOT the system prompt.
   *
   * The prompt used to be written verbatim into the session file, which parked
   * the agent's full capability spec (tools + memory + rules + mode blocks) in
   * plaintext on disk, in backups, and in anything that later archived the
   * file. It was also never read back: Agent constructs the session and then
   * calls `setSystemPrompt()` immediately, so a stored copy had no consumer.
   *
   * Belt and braces: besides never adding the prompt to `messages`, `save()`
   * also strips any `role: "system"` row that ever lands here, so a future
   * caller cannot silently reintroduce the leak by pushing one.
   *
   * `load()` still accepts a legacy `system` field and discards it, so old
   * session files keep resuming — they just stop being a leak.
   */
  save(file: string): void {
    if (isRemoteUncPath(file)) {
      // Fail closed without touching the path: mkdir/write on a UNC target
      // would authenticate to the remote host (NTLM hash leak).
      try {
        process.stderr.write(`trayambak: refusing to save session to remote UNC path "${file}".\n`)
      } catch {
        /* stderr unavailable */
      }
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { messages: this.messages.filter((m) => m.role !== "system") }
    const body = JSON.stringify(payload, null, 2)
    // Write to a sibling temp file and rename into place. A crash mid-write used
    // to leave a truncated file that `load` could not parse, so it reported "no
    // session" and the next save overwrote it — the entire transcript lost, with
    // no error anywhere. Mode 0600 because this file holds the user's prompts and
    // full tool output; the umask default (0644 on POSIX) left it world-readable,
    // unlike the sibling stores in `transcript.ts` and `session-manager.ts`.
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* best-effort cleanup of the temp file */
      }
      throw error
    }
  }

  static load(file: string): Session | null {
    if (isRemoteUncPath(file)) {
      // Fail closed without touching the path: existsSync/readFileSync on a
      // UNC target would authenticate to the remote host (NTLM hash leak).
      try {
        process.stderr.write(`trayambak: refusing to load session from remote UNC path "${file}".\n`)
      } catch {
        /* stderr unavailable */
      }
      return null
    }
    if (!fs.existsSync(file)) return null
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_SESSION_FILE_BYTES) {
        try {
          process.stderr.write(`trayambak: refusing to load oversized session file "${file}" (${stat.size} bytes).\n`)
        } catch {
          /* stderr unavailable */
        }
        return null
      }
      const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
        system?: string
        messages?: unknown
      }
      const s = new Session()
      // Legacy files carry a `system` field. It is intentionally NOT applied:
      // the caller rebuilds the prompt from config, and restoring a stale copy
      // from disk would pin an outdated (or tampered) prompt.
      s.messages.push(...sanitizeRestoredMessages(payload.messages))
      return s
    } catch {
      return null
    }
  }
}

function toWire(m: AgentMessage): WireMessage {
  switch (m.role) {
    case "system":
      return { role: "system", content: (m as SystemMessage).content }
    case "user": {
      const u = m as UserMessage
      const images = u.images?.filter((d) => typeof d === "string" && d.startsWith("data:image/"))
      return {
        role: "user",
        content: u.content,
        ...(images && images.length > 0 ? { images } : {}),
      }
    }
    case "assistant": {
      const a = m as AssistantMessage
      const text = a.content
        .filter((c) => c.type === "text" || c.type === "thinking")
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n")
      const toolCalls: WireToolCall[] = a.content
        .filter((c) => c.type === "toolCall")
        .map((c) => {
          const tc = c as Extract<AssistantMessage["content"][number], { type: "toolCall" }>
          return {
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }
        })
      return { role: "assistant", content: text, tool_calls: toolCalls.length ? toolCalls : undefined }
    }
    case "tool": {
      const t = m as ToolResultMessage
      return {
        role: "tool",
        content: t.content.map((c) => c.text).join("\n"),
        tool_call_id: t.toolCallId,
      }
    }
  }
}

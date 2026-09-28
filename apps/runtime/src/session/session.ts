/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../../../../packages/protocol/src/index.js"
import type { WireMessage, WireToolCall } from "../../../../packages/provider/src/index.js"

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
    }
    return out
  }

  save(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { system: this.systemPrompt, messages: this.messages }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8")
  }

  static load(file: string): Session | null {
    if (!fs.existsSync(file)) return null
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
        system: string
        messages: AgentMessage[]
      }
      const s = new Session()
      s.setSystemPrompt(payload.system)
      s.messages.push(...payload.messages)
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
    case "user":
      return { role: "user", content: (m as UserMessage).content }
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

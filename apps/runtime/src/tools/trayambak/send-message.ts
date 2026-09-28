/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const INBOX_DIR = path.join(os.homedir(), ".trayambak", "inbox")

export interface InboxMessage {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly content: string
  readonly timestamp: number
  readonly read: boolean
}

function inboxFile(agentId: string): string {
  return path.join(INBOX_DIR, `${agentId}.jsonl`)
}

export function inboxPath(agentId: string): string {
  return inboxFile(agentId)
}

export function readInbox(agentId: string, limit = 50): InboxMessage[] {
  try {
    const file = inboxFile(agentId)
    if (!fs.existsSync(file)) return []
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
    const messages: InboxMessage[] = []
    for (const line of lines.slice(-limit)) {
      try {
        messages.push(JSON.parse(line) as InboxMessage)
      } catch {
        /* skip malformed */
      }
    }
    return messages
  } catch {
    return []
  }
}

export function clearInbox(agentId: string): boolean {
  try {
    const file = inboxFile(agentId)
    if (fs.existsSync(file)) fs.writeFileSync(file, "", "utf8")
    return true
  } catch {
    return false
  }
}

export function sendToInbox(to: string, from: string, content: string): InboxMessage {
  const message: InboxMessage = {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
    content,
    timestamp: Date.now(),
    read: false,
  }
  const file = inboxFile(to)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(message) + "\n", "utf8")
  return message
}

const def: ToolDefinition = {
  name: "trayambak__SendMessage",
  description:
    "Send a message to a previously spawned trayambak__Agent. Running background jobs read it next turn and continue with context intact; messages to finished or unknown ids are stored but never read (the result says which). Use agent name or ID. Messages are persisted to a durable inbox file.",
  parameters: {
    type: "object",
    required: ["to", "content"],
    properties: {
      to: { type: "string", description: "Agent name or ID to send to." },
      content: { type: "string", description: "Message content." },
      from: { type: "string", description: "Optional sender identifier. Defaults to 'trayambak'." },
    },
  },
}

export interface SendMessageTarget {
  id: string
  name: string
  running: boolean
}

export interface SendMessageOptions {
  /** Resolve a recipient to a known agent. When present the tool answers
   *  honestly about delivery instead of always claiming a queue write. */
  resolveTarget?: (to: string) => SendMessageTarget | undefined
}

export function createSendMessageTool(
  sender?: (to: string, content: string) => Promise<string>,
  opts?: SendMessageOptions,
): Tool {
  return {
    definition: def,
    async execute(_id, args, _signal, _update, context) {
      const to = String(args.to ?? "")
      const content = String(args.content ?? "")
      if (!to || !content) return textResult("Missing 'to' or 'content'.", true)
      const from = String(args.from ?? context?.sessionId ?? "trayambak")

      // Persist to durable inbox file
      const message = sendToInbox(to, from, content)

      if (sender) {
        try {
          const reply = await sender(to, content)
          return textResult(`Message ${message.id} sent to ${to}.\nReply: ${reply}`)
        } catch (err) {
          return textResult(
            `Message ${message.id} persisted to inbox for ${to}. Delivery callback failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      // No live-delivery callback: answer honestly about WHO reads this.
      // A running messageable job polls its inbox file every turn, so it
      // WILL continue with context intact; anything else (finished or
      // unknown id) leaves the message unread forever — say so instead of
      // the old silent "queued" that looked delivered but did nothing.
      const target = opts?.resolveTarget ? opts.resolveTarget(to) : undefined
      if (target && target.running) {
        return textResult(
          `Message ${message.id} delivered to running job "${target.name}" — it reads its inbox next turn and continues with context intact.`,
        )
      }
      if (target && !target.running) {
        return textResult(
          `Message ${message.id} stored, but job "${target.name}" already finished — nobody will read it. Relaunch the task to continue.`,
          true,
        )
      }
      return textResult(
        `Message ${message.id} stored, but no running agent matches "${to}" — nobody will read it. Use an active background job id or name.`,
        true,
      )
    },
  }
}

export function getInboxSummary(agentId: string): string {
  const messages = readInbox(agentId, 100)
  if (messages.length === 0) return `Inbox for ${agentId}: empty`
  const unread = messages.filter((m) => !m.read).length
  return `Inbox for ${agentId}: ${messages.length} messages (${unread} unread)`
}

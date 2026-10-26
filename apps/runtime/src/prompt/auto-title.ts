/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * AI session titling — "chat ka title AI starting me khud banke de (5
 * words)": ONE tiny completion that names a conversation in AT MOST FIVE
 * WORDS. Sits beside prompt-enhance and shares its wire shape
 * (chat-completions POST + reply cleaning), but carries its own
 * instruction: it must return a bare title, never an answer, and
 * `toFiveWords` re-caps the reply client-side because models obey "five
 * words" only approximately.
 *
 * Nemo surface: App auto-titles a fresh session after its first real
 * reply (renameSession → sidebar, /resume list, resume banner), falling
 * back to the prompt's own first words when this call fails — a title can
 * never break a turn.
 */

import { chatCompletionsUrl, clean, extractContent, type EnhanceResponse } from "./enhance-prompt.js"

/** The naming instruction — deliberately narrower than the enhance one. */
export const TITLE_INSTRUCTION = [
  "You name chat sessions for a coding assistant.",
  "You receive an excerpt of one conversation; reply with a title for it in AT MOST FIVE WORDS.",
  "Return ONLY the title: no quotes, no markdown, no trailing punctuation, no preamble, no explanation.",
  "Prefer concrete subject plus action words, like a good git branch name said out loud.",
].join(" ")

export interface AutoTitleOptions {
  baseUrl: string
  apiKey?: string
  model: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<EnhanceResponse>
  /** A title should land right after the turn; default 15s (patient enough
   *  for a cold local model, short enough to never feel stuck). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Hard five-word cap with quote/fence/punctuation cleanup — the model's
 *  reply is shaped into a usable session NAME even when it disobeys the
 *  instruction (`"Fix the login token refresh bug, please!"` → `Fix the
 *  login token refresh bug`). Empty/debris input yields "" and the caller
 *  falls back to the prompt's own first words. */
export function toFiveWords(text: string): string {
  const words = clean(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5)
  if (words.length === 0) return ""
  // clean() only unwraps a perfectly-matching quote pair — `"Fix the bug".`
  // survives with its debris. Scrub both ends instead.
  words[0] = words[0]!.replace(/^["'`\u201c\u2018(]+/, "")
  const last = words.length - 1
  words[last] = words[last]!.replace(/[.,;:!?"'\u2019\u201d`)\]]+$/, "")
  return words.filter(Boolean).join(" ")
}

/**
 * Name the conversation described by `excerpt`. Throws on transport/HTTP/
 * shape failures (the caller falls back to the prompt's own first words),
 * so the auto-title path can report a problem without ever breaking the
 * chat it is titling.
 */
export async function generateChatTitle(excerpt: string, opts: AutoTitleOptions): Promise<string> {
  const draft = excerpt.trim()
  if (!draft) throw new Error("nothing to title")

  const payload = JSON.stringify({
    model: opts.model,
    messages: [
      { role: "system", content: TITLE_INSTRUCTION },
      { role: "user", content: `Conversation excerpt to name:\n\n${draft}` },
    ],
    temperature: 0.2,
  })

  const fetchImpl =
    opts.fetchImpl ?? ((u: string, init: Record<string, unknown>): Promise<EnhanceResponse> => fetch(u, init))

  const response = await fetchImpl(chatCompletionsUrl(opts.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: payload,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })

  if (!response.ok) {
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      /* body unavailable */
    }
    throw new Error(`title failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`title failed: unreadable response (${error instanceof Error ? error.message : String(error)})`)
  }

  const content = extractContent(body)
  if (content === undefined) throw new Error("title failed: unexpected response shape")

  const title = toFiveWords(content)
  if (!title) throw new Error("title failed: model returned an empty title")
  return title
}

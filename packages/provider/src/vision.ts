/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { WireContentPart, WireMessage } from "./types.js"

/**
 * Cap on how many pictures ride along with one message.
 *
 * OpenAI-compatible endpoints count every image as a high-detail tile group,
 * and the request is rejected outright once the budget blows — a single
 * 2048px screenshot is ~1100 tiles on the high path. Four keeps a normal
 * "look at these three screenshots" turn well inside the limit; a user who
 * attaches more than four still gets the first four rather than a hard error,
 * because dropping the turn entirely would be worse than dropping pictures.
 */
export const MAX_IMAGES_PER_MESSAGE = 4

/** Data URLs only — a bare path or http URL is not something a backend can read. */
function usableImages(images: string[] | undefined): string[] {
  if (!images || images.length === 0) return []
  return images.filter((u) => typeof u === "string" && u.startsWith("data:image/")).slice(0, MAX_IMAGES_PER_MESSAGE)
}

/**
 * OpenAI chat-completions content parts for one message.
 *
 * Returns the plain string when there is nothing to expand, so the common
 * text-only path is byte-identical to before — a message with no images must
 * never change shape on the wire, or every existing conversation replay
 * changes meaning.
 */
export function toContentParts(message: WireMessage): string | null | WireContentPart[] {
  const images = message.role === "user" ? usableImages(message.images) : []
  // Return the original value, not `message.content ?? ""`: an assistant row
  // carrying only `tool_calls` must keep `content: null`, and coercing it to
  // an empty string is exactly the shape change this function promises not to
  // make. Strict OpenAI-compatible gateways reject that substitution.
  if (images.length === 0) return message.content
  const text = message.content ?? ""
  // An image with no prose still needs a text part: some gateways (and every
  // strict validator) reject a parts array whose first element is not text.
  const parts: WireContentPart[] = []
  parts.push({ type: "text", text: text.length > 0 ? text : "See the attached image." })
  for (const url of images) parts.push({ type: "image_url", image_url: { url } })
  return parts
}

/** A wire message whose `content` may have been widened to OpenAI content parts. */
export interface ExpandedWireMessage extends Omit<WireMessage, "content"> {
  content: string | null | WireContentPart[]
}

/**
 * Expand a message list into the shape an OpenAI-compatible endpoint wants.
 *
 * Only user rows carry pictures; system/assistant/tool rows pass through with
 * their original string `content` so their serialization is untouched.
 */
export function expandWireMessages(messages: WireMessage[]): ExpandedWireMessage[] {
  const out: ExpandedWireMessage[] = []
  for (const m of messages) {
    const content = toContentParts(m)
    if (typeof content === "string") {
      out.push(m)
      continue
    }
    // Drop the sibling field once expanded, so `images` can never be
    // double-encoded by a backend that happens to forward unknown keys.
    const { images: _images, ...rest } = m
    out.push({ ...rest, content })
  }
  return out
}

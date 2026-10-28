/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Historical media stripping.
 *
 * A compaction replaces old turns with a summary, but the ATTACHMENTS on those
 * turns survive in the session: images and PDFs are held as `data:` URLs on the
 * wire message, and a single screenshot is easily several hundred kilobytes of
 * base64. Every subsequent request re-ships all of it, so a session that looked
 * like it had been compacted keeps paying for images nobody is looking at any
 * more — and the provider rejects the payload long before the context window is
 * the limiting factor.
 *
 * The fix is to keep the fact that there WAS an attachment (so the transcript
 * still reads honestly and the model knows a picture was involved) and drop the
 * bytes. Current-turn attachments are never touched: the user is still looking
 * at them.
 */

/**
 * Anything that can carry inline media. Structural on purpose: the same rule
 * applies to a session message and to the wire message built from it, so this
 * works on the output of `Session.toWireMessages()` without reaching into the
 * session's private lowering — and without this module depending on the protocol
 * package at all.
 */
export interface MaybeWithMedia {
  readonly images?: string[] | undefined
}

/** How many trailing messages count as "the current turn". */
export const RECENT_MESSAGES_KEPT = 2

/** Marker describing a dropped attachment, for callers that want to say so. */
export const STRIPPED_MEDIA = "[attachment removed by context compaction]"

/**
 * True when a message carries inline media that would be re-sent as base64.
 */
export function hasInlineMedia(message: MaybeWithMedia): boolean {
  return (message.images?.length ?? 0) > 0
}

/**
 * Return a copy of `messages` with inline media dropped from everything older
 * than the recent tail.
 *
 * The tail is preserved by COUNT, not by any notion of turn boundaries: the
 * newest messages are the ones the user just supplied or just received, and a
 * caller that knows better can pass a different window.
 *
 * The input array and its messages are never mutated — callers hold these
 * objects for the whole session and the UI re-renders from them.
 */
export function stripHistoricalMedia<T extends MaybeWithMedia>(
  messages: readonly T[],
  keepRecent: number = RECENT_MESSAGES_KEPT,
): T[] {
  const cutoff = Math.max(0, messages.length - Math.max(0, keepRecent))
  let changed = false
  const out = messages.map((message, index) => {
    if (index >= cutoff || !hasInlineMedia(message)) return message
    changed = true
    return { ...message, images: undefined }
  })
  return changed ? out : (messages as T[])
}

/** How many messages in `messages` still carry inline media. */
export function countInlineMedia(messages: readonly MaybeWithMedia[]): number {
  return messages.reduce((total, message) => total + (hasInlineMedia(message) ? 1 : 0), 0)
}

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * useScrollToBottom drives chat-pane follow semantics:
 *   - starts following (autoScroll) with the viewport at the bottom;
 *   - scroll UP turns following off; only REACHING the bottom (or a manual
 *     jump) turns it back on — a down-scroll mid-list never re-enables it;
 *   - "at the bottom" means within a fixed 20px buffer;
 *   - the manual jump is deferred to the next animation frame.
 *
 * This tree is the DOM-only logic program (tsconfig.logic.json: no node
 * types, no jsdom/testing-library in the repo), so the hook runs against a
 * minimal React dispatcher that stores state in slots and re-invokes the
 * hook body — the same contract a renderer provides, without pulling ink or
 * node:stream into the browser program. Every "render" below is one hook
 * invocation; state writes are visible on the next one.
 */
const harness = vi.hoisted(() => {
  const slots: unknown[] = []
  let cursor = 0
  return {
    resetSlots: (): void => {
      slots.length = 0
    },
    beginRender: (): void => {
      cursor = 0
    },
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const index = cursor++
      if (index >= slots.length) slots[index] = initial
      const write = (next: unknown): void => {
        slots[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[index]) : next
      }
      return [slots[index], write]
    },
    useRef: (initial: unknown): { current: unknown } => {
      const index = cursor++
      if (index >= slots.length) slots[index] = { current: initial }
      return slots[index] as { current: unknown }
    },
    useCallback: <T>(fn: T): T => fn,
  }
})

vi.mock("react", () => ({
  useState: harness.useState,
  useRef: harness.useRef,
  useCallback: harness.useCallback,
}))

import { useScrollToBottom } from "./use-scroll-to-bottom.js"

type HookResult = ReturnType<typeof useScrollToBottom>

/** Queued animation frames, flushed by hand so nothing races the assertions. */
let frames: FrameRequestCallback[] = []

const flushFrames = (): void => {
  const pending = frames
  frames = []
  for (const callback of pending) callback(0)
}

const render = (ref: { current: HTMLDivElement | null }): HookResult => {
  harness.beginRender()
  return useScrollToBottom(ref)
}

/** Scroll metrics the hook reads off the chat body. */
const scrollArea = (over: Partial<HTMLElement>): HTMLElement =>
  ({ scrollTop: 0, clientHeight: 0, scrollHeight: 0, ...over }) as unknown as HTMLElement

const BOTTOM = (): HTMLElement => scrollArea({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })

let ref: { current: HTMLDivElement | null }

beforeEach(() => {
  harness.resetSlots()
  frames = []
  ref = { current: null }
  ;(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: FrameRequestCallback): number => {
    frames.push(callback)
    return frames.length
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).requestAnimationFrame
})

describe("useScrollToBottom", () => {
  it("starts following the bottom and hands back the caller's ref", () => {
    const result = render(ref)
    expect(result.autoScroll).toBe(true)
    expect(result.hitBottom).toBe(true)
    expect(result.scrollRef).toBe(ref)
  })

  it("uses a fixed 20px buffer to decide 'at the bottom', and at-bottom wins over scroll-up", () => {
    let result = render(ref)

    // 400px viewport, 1000px content: bottom position is reached at 600.
    result.onChatBodyScroll(BOTTOM())
    result = render(ref)
    expect(result.hitBottom).toBe(true)
    expect(result.autoScroll).toBe(true)

    // Still inside the 20px buffer (580 + 400 = 980 = 1000 - 20): following
    // survives an up-scroll because reaching the bottom re-enables it.
    result.onChatBodyScroll(scrollArea({ scrollTop: 580, clientHeight: 400, scrollHeight: 1000 }))
    result = render(ref)
    expect(result.hitBottom).toBe(true)
    expect(result.autoScroll).toBe(true)

    // One pixel past the buffer: no longer at the bottom, and the up-scroll
    // turns following off.
    result.onChatBodyScroll(scrollArea({ scrollTop: 579, clientHeight: 400, scrollHeight: 1000 }))
    result = render(ref)
    expect(result.hitBottom).toBe(false)
    expect(result.autoScroll).toBe(false)
  })

  it("turns following off on scroll-up and only re-enables at the bottom", () => {
    let result = render(ref)

    // Start at the bottom, then scroll up into the history.
    result.onChatBodyScroll(BOTTOM())
    result.onChatBodyScroll(scrollArea({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 }))
    result = render(ref)
    expect(result.autoScroll).toBe(false)
    expect(result.hitBottom).toBe(false)

    // Scrolling back DOWN mid-list does not re-enable following…
    result.onChatBodyScroll(scrollArea({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }))
    result = render(ref)
    expect(result.autoScroll).toBe(false)
    expect(result.hitBottom).toBe(false)

    // …only reaching the bottom again does.
    result.onChatBodyScroll(BOTTOM())
    result = render(ref)
    expect(result.autoScroll).toBe(true)
    expect(result.hitBottom).toBe(true)
  })

  it("defers the manual jump to the next animation frame", () => {
    const div = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 } as unknown as HTMLDivElement
    ref.current = div
    let result = render(ref)

    // Put the pane in "not following" state first: reach the bottom, then
    // scroll up into history.
    result.onChatBodyScroll(BOTTOM())
    result.onChatBodyScroll(scrollArea({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 }))
    result = render(ref)
    expect(result.autoScroll).toBe(false)

    result.scrollDomToBottom()
    // The jump is scheduled, not applied: nothing moved yet.
    expect(frames).toHaveLength(1)
    expect(div.scrollTop).toBe(100)
    expect(render(ref).autoScroll).toBe(false)

    flushFrames()
    result = render(ref)
    expect(div.scrollTop).toBe(div.scrollHeight)
    expect(result.autoScroll).toBe(true)
    expect(result.hitBottom).toBe(true)
  })

  it("does nothing when the scroll element is not mounted yet", () => {
    const result = render(ref)
    expect(() => result.scrollDomToBottom()).not.toThrow()
    expect(frames).toHaveLength(0)
    expect(result.autoScroll).toBe(true)
  })

  it("exposes setters that flip the follow flags directly", () => {
    let result = render(ref)
    result.setAutoScroll(false)
    result.setHitBottom(false)
    result = render(ref)
    expect(result.autoScroll).toBe(false)
    expect(result.hitBottom).toBe(false)

    result.setAutoScroll(true)
    result.setHitBottom(true)
    result = render(ref)
    expect(result.autoScroll).toBe(true)
    expect(result.hitBottom).toBe(true)
  })
})

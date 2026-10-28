/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import { buildAgentCanvasPath, getAgentCanvasBasePath } from "./base-path.js"

/** The tree is DOM-targeted but these branches are testable in Node:
 *  `typeof window` guards the injected-base lookup. */
const fakeWindow = (injected: unknown): void => {
  ;(globalThis as Record<string, unknown>).window = { __AGENT_CANVAS_BASE_PATH__: injected }
}
const dropWindow = (): void => {
  delete (globalThis as Record<string, unknown>).window
}

afterEach(dropWindow)

describe("getAgentCanvasBasePath", () => {
  it("returns empty string with no env base and no window (Node)", () => {
    dropWindow()
    expect(getAgentCanvasBasePath()).toBe("")
  })

  it("reads an injected window base, normalizing slashes both ends", () => {
    fakeWindow("/app/")
    expect(getAgentCanvasBasePath()).toBe("/app")
    fakeWindow("app")
    expect(getAgentCanvasBasePath()).toBe("/app")
    fakeWindow("/")
    expect(getAgentCanvasBasePath()).toBe("")
  })

  it("ignores non-string injections", () => {
    fakeWindow(42)
    expect(getAgentCanvasBasePath()).toBe("")
  })
})

describe("buildAgentCanvasPath", () => {
  it("adds a leading slash when there is no base", () => {
    dropWindow()
    expect(buildAgentCanvasPath("chat")).toBe("/chat")
    expect(buildAgentCanvasPath("/chat")).toBe("/chat")
  })

  it("prefixes the base exactly once", () => {
    fakeWindow("/canvas")
    expect(buildAgentCanvasPath("chat")).toBe("/canvas/chat")
    expect(buildAgentCanvasPath("/chat")).toBe("/canvas/chat")
  })
})

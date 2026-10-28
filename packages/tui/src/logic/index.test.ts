/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as logic from "./index.js"
import { I18nKey } from "./i18n-declaration.js"
import { OH_STATUS_ERROR_COLOR, OH_STATUS_SUCCESS_COLOR } from "./status-colors.js"
import { isMarkdownFilePath } from "./is-markdown-file-path.js"
import { readScrollFadeState } from "./scroll-fade-state.js"
import { getAgentCanvasBasePath } from "./base-path.js"
import { cn } from "./utils.js"

/**
 * The barrel is the logic tree's public surface (its own header documents a
 * history of exports that never existed and broke the whole tree). These
 * tests pin that every documented name resolves to the module that owns it —
 * a broken or dropped re-export fails here instead of at app import time.
 */
describe("logic barrel (index.ts)", () => {
  it("exports the class-merge helper as a working function", () => {
    expect(logic.cn).toBe(cn)
    expect(logic.cn("p-2", "p-4")).toBe("p-4")
  })

  it("re-exports the markdown/canvas/scroll helpers from their owners", () => {
    expect(logic.isMarkdownFilePath).toBe(isMarkdownFilePath)
    expect(logic.getAgentCanvasBasePath).toBe(getAgentCanvasBasePath)
    expect(logic.readScrollFadeState).toBe(readScrollFadeState)
    expect(typeof logic.buildAgentCanvasPath).toBe("function")
  })

  it("re-exports the three interaction hooks", () => {
    expect(typeof logic.useScrollToBottom).toBe("function")
    expect(typeof logic.useHandlePlanClick).toBe("function")
    expect(typeof logic.useHandleBuildPlanClick).toBe("function")
    expect(typeof logic.useSelectConversationTab).toBe("function")
  })

  it("re-exports the i18n enum and status colors by identity", () => {
    expect(logic.I18nKey).toBe(I18nKey)
    expect(logic.OH_STATUS_SUCCESS_COLOR).toBe(OH_STATUS_SUCCESS_COLOR)
    expect(logic.OH_STATUS_ERROR_COLOR).toBe(OH_STATUS_ERROR_COLOR)
    // Consumers style these through CSS custom properties, not raw colors.
    expect(logic.OH_STATUS_SUCCESS_COLOR.startsWith("var(--oh-status-")).toBe(true)
    expect(logic.OH_STATUS_ERROR_COLOR.startsWith("var(--oh-status-")).toBe(true)
  })

  it("re-exports the shared class-name constants as non-empty strings", () => {
    for (const value of [
      logic.formControlButtonClassName,
      logic.formControlHeightClassName,
      logic.formControlFieldClassName,
      logic.formControlShellClassName,
      logic.dropdownTriggerShellClassName,
      logic.dropdownMenuListClassName,
      logic.dropdownMenuListGapClassName,
      logic.dropdownMenuRowClassName,
      logic.dropdownMenuRowIconWrapperClassName,
    ]) {
      expect(typeof value).toBe("string")
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it("keeps the ScrollFadeState type alias usable through the barrel", () => {
    const state: logic.ScrollFadeStateType = readScrollFadeState({
      scrollLeft: 0,
      scrollWidth: 10,
      clientWidth: 10,
    } as unknown as HTMLElement)
    expect(state).toEqual({ left: false, right: false })
  })

  it("exposes the top-level workspace base path default", () => {
    // No env/window injection in this Node run → paths root at "/".
    expect(logic.buildAgentCanvasPath("chat")).toBe("/chat")
    expect(logic.buildAgentCanvasPath("/chat")).toBe("/chat")
  })
})

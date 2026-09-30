/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * The legacy (pre-ink) TUI tree — app/ (state machine), bottom_pane/
 * (composer), chatwidget/, tui/ (raw terminal) — is kept ALIVE through the
 * barrel block in index.ts: first-class tsconfig members, emitted to dist,
 * re-exported here. These asserts guard the wiring itself, so a dropped
 * re-export or an un-aliased name collision fails the gate before it fails
 * a consumer.
 */
import { describe, expect, it } from "vitest"
import { AppState, Composer, ChatWidget, Tui } from "./index"
import type {
  AppEventHandler,
  AppExitInfo,
  AppStateApprovalRequest,
  AppStateEvent,
  ExitMode,
  PermissionRequest,
  TrayambakConfig,
  TuiEvent,
} from "./index"

/** Compile-time surface probe: this alias only builds if EVERY name below
 *  still resolves on ./index — the typecheck gate is the assertion. */
export type LegacyTuiBarrelSurface = {
  event: AppStateEvent
  approval: AppStateApprovalRequest
  config: TrayambakConfig
  permission: PermissionRequest
  tuiEvent: TuiEvent
  handler: AppEventHandler
  exitMode: ExitMode
  exitInfo: AppExitInfo
}

describe("legacy TUI barrel wiring", () => {
  it("re-exports the constructable legacy classes", () => {
    expect(typeof AppState).toBe("function")
    expect(typeof Composer).toBe("function")
    expect(typeof ChatWidget).toBe("function")
    expect(typeof Tui).toBe("function")
  })

  it("keeps the legacy type surface reachable (compile-time)", () => {
    const surface: LegacyTuiBarrelSurface | undefined = undefined
    expect(surface).toBeUndefined()
  })
})

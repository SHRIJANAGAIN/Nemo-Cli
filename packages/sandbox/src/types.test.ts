import { describe, expect, it } from "vitest"
import { detectSandboxType, SandboxType } from "./types.js"

/**
 * `detectSandboxType` decides the sandbox marker that `getSafeEnv` stamps
 * verbatim into the child environment as `CODEX_SANDBOX`. A marker that
 * claims enforcement which is never applied is worse than no marker, so
 * these tests pin the honest-detection contract:
 *
 *  - mode/uiMode short-circuits report `None` (no OS sandbox is wired for
 *    them today);
 *  - detection NEVER reports `WindowsRestrictedToken` — the restricted-token
 *    spawn path delegates to unsandboxed and reports `None`/`isSandboxed:
 *    false`, so detection must not contradict it (audit finding P2#11).
 */
describe("detectSandboxType", () => {
  it("yolo mode gets no sandbox", () => {
    expect(detectSandboxType({ mode: "yolo" })).toBe(SandboxType.None)
  })

  it("full-access uiMode gets no sandbox", () => {
    expect(detectSandboxType({ uiMode: "full-access" })).toBe(SandboxType.None)
  })

  it("read-only uiMode reports none until OS sandboxing is wired", () => {
    expect(detectSandboxType({ uiMode: "read-only" })).toBe(SandboxType.None)
  })

  it("plan uiMode reports none until OS sandboxing is wired", () => {
    expect(detectSandboxType({ uiMode: "plan" })).toBe(SandboxType.None)
  })

  it("win32 detection returns None — never a restricted token that is not applied", () => {
    withPlatform("win32", () => {
      // Pre-fix behavior returned WindowsRestrictedToken here while
      // spawnUnderWindowsRestrictedToken delegated to unsandboxed — the
      // exact detection/spawn contradiction this test pins closed.
      expect(detectSandboxType({})).toBe(SandboxType.None)
    })
  })

  it("detection never reports WindowsRestrictedToken on any platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const detected = withPlatform(platform, () => detectSandboxType({}))
      expect(detected).not.toBe(SandboxType.WindowsRestrictedToken)
    }
  })
})

/** Swap `process.platform` for the duration of `fn`, restoring the exact
 *  original property descriptor afterward (Node defines it configurable). */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(process, "platform", original)
  }
}

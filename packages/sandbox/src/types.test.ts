import { describe, expect, it } from "vitest"
import { detectSandboxType, SandboxType } from "./types.js"
import { setWindowsAcProbeForTests } from "./windows-ac.js"

/**
 * `detectSandboxType` decides the sandbox marker that `getSafeEnv` stamps
 * verbatim into the child environment as `CODEX_SANDBOX`. A marker that
 * claims enforcement which is never applied is worse than no marker, so
 * these tests pin the honest-detection contract:
 *
 *  - mode/uiMode short-circuits report `None` (no OS sandbox is wired for
 *    them today);
 *  - win32 reports `WindowsRestrictedToken` ONLY when the helper probe
 *    passes (injected in tests — the real default answers false under
 *    NODE_ENV=test); spawnProcess backs the claim with a per-spawn status
 *    handshake and falls back to an honest `isSandboxed: false` spawn if
 *    the AppContainer child never comes up;
 *  - non-windows platforms never report `WindowsRestrictedToken`.
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

  it("win32 without helper infrastructure reports None — never an unapplied token", () => {
    setWindowsAcProbeForTests(() => false)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({})).toBe(SandboxType.None)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("win32 with helper infrastructure reports WindowsRestrictedToken", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({})).toBe(SandboxType.WindowsRestrictedToken)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("non-windows platforms never report WindowsRestrictedToken, even with a passing probe", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      for (const platform of ["darwin", "linux"] as const) {
        const detected = withPlatform(platform, () => detectSandboxType({}))
        expect(detected).not.toBe(SandboxType.WindowsRestrictedToken)
      }
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("win32 without an injected probe stays None in unit tests (NODE_ENV=test)", () => {
    withPlatform("win32", () => {
      expect(detectSandboxType({})).toBe(SandboxType.None)
    })
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

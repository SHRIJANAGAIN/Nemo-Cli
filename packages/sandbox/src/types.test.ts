import { describe, expect, it } from "vitest"
import { detectSandboxType, SandboxType } from "./types.js"
import { setWindowsAcProbeForTests } from "./windows-ac.js"

/**
 * `detectSandboxType` decides the sandbox marker that `getSafeEnv` stamps
 * verbatim into the child environment as `NEMO_SANDBOX`. A marker that
 * claims enforcement which is never applied is worse than no marker, so
 * these tests pin the honest-detection contract:
 *
 *  - the isolate is a property of the PLATFORM, so no permission mode
 *    short-circuits to `None` any more. `yolo` / `full-access` /
 *    `read-only` / `plan` all run under the isolator when one exists;
 *    the mode now selects the *filesystem* policy instead (see
 *    `isReadOnlyMode` + `osSpawnRequest({ readOnly: true })` in bash.ts).
 *    The two modes that used to bypass the sandbox were `yolo` (a config
 *    alias silently removing OS containment) and `read-only`/`plan` (the
 *    unimplemented placeholder) - both backwards, and the second one meant
 *    the safest sessions had the least containment;
 *  - the feature flag still wins: `sandboxSpawn=0` reports `None` so the
 *    stamped marker can never claim an isolator that is not engaged;
 *  - win32 reports `WindowsRestrictedToken` ONLY when the helper probe
 *    passes (injected in tests - the real default answers false under
 *    NODE_ENV=test); spawnProcess backs the claim with a per-spawn status
 *    handshake and falls back to an honest `isSandboxed: false` spawn if
 *    the AppContainer child never comes up;
 *  - non-windows platforms never report `WindowsRestrictedToken`.
 */
describe("detectSandboxType", () => {
  it("yolo mode no longer disables the sandbox", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({ mode: "yolo" })).toBe(SandboxType.WindowsRestrictedToken)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("full-access uiMode no longer disables the sandbox", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({ uiMode: "full-access" })).toBe(SandboxType.WindowsRestrictedToken)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("read-only uiMode engages the isolator (restriction is the FS policy)", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({ uiMode: "read-only" })).toBe(SandboxType.WindowsRestrictedToken)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("plan uiMode engages the isolator (restriction is the FS policy)", () => {
    setWindowsAcProbeForTests(() => true)
    try {
      withPlatform("win32", () => {
        expect(detectSandboxType({ uiMode: "plan" })).toBe(SandboxType.WindowsRestrictedToken)
      })
    } finally {
      setWindowsAcProbeForTests(null)
    }
  })

  it("sandboxSpawn=0 reports None so the stamped marker stays honest", () => {
    const previous = process.env.FEATURE_SANDBOXSPAWN
    process.env.FEATURE_SANDBOXSPAWN = "0"
    try {
      setWindowsAcProbeForTests(() => true)
      withPlatform("win32", () => {
        expect(detectSandboxType({})).toBe(SandboxType.None)
      })
      // ...even for the modes that used to bypass the flag entirely.
      withPlatform("win32", () => {
        expect(detectSandboxType({ mode: "yolo" })).toBe(SandboxType.None)
        expect(detectSandboxType({ uiMode: "plan" })).toBe(SandboxType.None)
      })
    } finally {
      setWindowsAcProbeForTests(null)
      if (previous === undefined) delete process.env.FEATURE_SANDBOXSPAWN
      else process.env.FEATURE_SANDBOXSPAWN = previous
    }
  })

  it("win32 without helper infrastructure reports None - never an unapplied token", () => {
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

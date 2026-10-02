/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * OS-sandbox engagement gate — the single decision point for whether a tool
 * run spawns under real OS isolation or stays on in-process policy.
 *
 * OS enforcement engages when the `sandboxSpawn` feature flag is on
 * (the default: `STABLE_FEATURES.sandboxSpawn` is true; `FEATURE_SANDBOXSPAWN=0`
 * forces it off) AND the backend has a real isolator (seatbelt, landlock,
 * bwrap, windows-restricted) — unknown platforms stay policy-only because
 * no OS enforcement exists there, and the handle must never claim isolation
 * it does not have. `windows-restricted` is the AppContainer backend
 * (windows-ac.ts); its per-spawn status handshake decides real isolation,
 * falling back to an honest unsandboxed spawn when the shim cannot start.
 */

import { isEnabled } from "../../core/src/feature_flags.js"
import { SandboxType } from "./types.js"

/** Backends with a real OS isolator behind them. */
export function osCapableBackend(backend: string): boolean {
  return backend === "seatbelt" || backend === "landlock" || backend === "bwrap" || backend === "windows-restricted"
}

/** True when this run must go through spawnProcess under OS isolation. */
export function shouldUseOsSandbox(sandboxType: SandboxType): boolean {
  if (!isEnabled("sandboxSpawn")) return false
  return (
    sandboxType === SandboxType.MacosSeatbelt ||
    sandboxType === SandboxType.LinuxSeccomp ||
    sandboxType === SandboxType.WindowsRestrictedToken
  )
}

/**
 * Single source of truth for a backend's enforcement label: the
 * `sandboxSpawn` flag AND a backend with a real isolator, nothing else.
 *
 * `describeEnforcement` (CLI status) and `enforcementFor`
 * (`SandboxCheck` in index.ts) both route here so no two surfaces can
 * disagree about what the sandbox actually does. Where a real isolator
 * exists the default is already `os-sandbox` (`STABLE_FEATURES.sandboxSpawn`
 * is true); `FEATURE_SANDBOXSPAWN=0` forces everything back to `policy-only`.
 */
export function enforcementForBackend(backend: string): "policy-only" | "os-sandbox" {
  return isEnabled("sandboxSpawn") && osCapableBackend(backend) ? "os-sandbox" : "policy-only"
}

/** Honest enforcement label for status surfaces (`sandbox` CLI). */
export function describeEnforcement(backend: string): "policy-only" | "os-sandbox" {
  return enforcementForBackend(backend)
}

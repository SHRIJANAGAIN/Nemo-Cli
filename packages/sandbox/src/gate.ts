/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * OS-sandbox engagement gate — the single decision point for whether a tool
 * run spawns under real OS isolation or stays on in-process policy.
 *
 * OS enforcement is opt-in behind the `sandboxSpawn` feature flag
 * (`FEATURE_SANDBOXSPAWN=1`): the flag defaults off, and only backends with
 * a real isolator (seatbelt, landlock, bwrap) ever engage — Windows and
 * unknown platforms stay policy-only because no OS enforcement exists
 * there, and the handle must never claim isolation it does not have.
 */

import { isEnabled } from "../../core/src/feature_flags.js"
import { SandboxType } from "./types.js"

/** Backends with a real OS isolator behind them. */
export function osCapableBackend(backend: string): boolean {
  return backend === "seatbelt" || backend === "landlock" || backend === "bwrap"
}

/** True when this run must go through spawnProcess under OS isolation. */
export function shouldUseOsSandbox(sandboxType: SandboxType): boolean {
  if (!isEnabled("sandboxSpawn")) return false
  return sandboxType === SandboxType.MacosSeatbelt || sandboxType === SandboxType.LinuxSeccomp
}

/**
 * Single source of truth for a backend's enforcement label: the
 * `sandboxSpawn` flag AND a backend with a real isolator, nothing else.
 *
 * `describeEnforcement` (CLI status) and `enforcementFor`
 * (`SandboxCheck` in index.ts) both route here so no two surfaces can
 * disagree about what the sandbox actually does. This creates the
 * truthful *path* to `os-sandbox`; it does not flip the default -
 * `STABLE_FEATURES.sandboxSpawn` stays false, so with the flag off every
 * backend still reports `policy-only`.
 */
export function enforcementForBackend(backend: string): "policy-only" | "os-sandbox" {
  return isEnabled("sandboxSpawn") && osCapableBackend(backend) ? "os-sandbox" : "policy-only"
}

/** Honest enforcement label for status surfaces (`sandbox` CLI). */
export function describeEnforcement(backend: string): "policy-only" | "os-sandbox" {
  return enforcementForBackend(backend)
}

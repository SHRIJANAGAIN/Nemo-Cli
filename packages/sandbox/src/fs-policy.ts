/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Filesystem policy → OS sandbox arguments.
 *
 * The bug this exists to fix
 * -------------------------
 * `SpawnRequest.filesystemPolicy` has always been declared and threaded all the
 * way from the policy engine into `spawnProcess`. Its own doc comment admitted
 * the gap: *"spawnProcess does not yet apply these to the OS sandbox itself"*.
 *
 * The justification in that comment was wrong, and the wrongness is the whole
 * problem. It claimed enforcement "defaults to policy-only", but
 * `shouldUseOsSandbox` returns true on macOS and Linux, `detectBackend()`
 * reports `seatbelt`/`bwrap`, and `spawnProcess` then returned
 * `isSandboxed: true`. So the runtime told the user — and every audit log, and
 * every status surface — that OS isolation was applied, while the two Linux/macOS
 * backends ignored the filesystem policy completely:
 *
 *  - **seatbelt** emitted `(allow default)`, which permits every file operation.
 *    A `read-only` session had unrestricted write access to the whole host.
 *  - **bubblewrap** emitted `--bind cwd cwd` unconditionally — read-write — so a
 *    `read-only` session could write inside the workspace too.
 *
 * A control that is declared, typed, threaded, and documented as unenforced is
 * worse than an absent one: the data flow looks complete, so a reviewer reads
 * past it, and the UI asserts isolation that was never applied.
 *
 * Why this is a separate module
 * -----------------------------
 * Both argument builders are pure functions of the policy, which is what makes
 * them testable on a machine with no `bwrap` and no macOS. `spawn.ts` is the only
 * caller. Keeping the SBPL and bubblewrap text generation here — rather than
 * inline in the spawn paths — is what lets the enforcement be asserted at all:
 * a Linux CI box can prove the macOS profile denies writes without a Mac.
 *
 * Semantics that are easy to get wrong, and are pinned by the tests
 * -----------------------------------------------------------------
 *  1. **Empty `writableRoots` means nothing is writable**, not "everything".
 *     An empty allow-list is a deny-all. Reading it the other way would hand a
 *     `read-only` session the entire filesystem.
 *  2. **The workspace is bound read-write only when it is in `writableRoots`.**
 *     It is not special-cased.
 *  3. **`readOnlySubpaths` beats `writableRoots`.** A deny always wins, which
 *     matches the repo rule that deny lists outrank allow lists.
 *  4. **A root the policy never mentions is not readable.** No implicit host root.
 */

import type { FileSystemSandboxPolicy } from "./types.js"

// Re-exported so callers building an argument list can name the policy type from
// the module that interprets it, rather than having to know it lives in types.ts
// and import from two places to construct one call.
export type { FileSystemSandboxPolicy }

/** Empty policy object — denies everything, deliberately. See note 1 above. */
export const DENY_ALL: FileSystemSandboxPolicy = {
  writableRoots: [],
  readOnlySubpaths: [],
  denyReadPaths: [],
  denyWritePaths: [],
}

/**
 * True when `target` is inside `root` (or IS `root`).
 *
 * Compares path SEGMENTS, not string prefixes. A prefix comparison treats
 * `/workspace` as containing `/workspace-backup`, so a deny on one silently
 * fails to cover its neighbour — and that neighbour is usually something like
 * `/home/user/.ssh`.
 *
 * The trailing-separator form is required because POSIX keeps the separator in
 * the parent path when building a child, so `/workspace/` must count as inside
 * `/workspace`.
 */
export function isInside(target: string, root: string): boolean {
  if (target === root) return true
  const normalizedRoot = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root
  if (normalizedRoot.length === 0) return false
  // Compare against the NORMALIZED root, not the raw one. A policy that spells a
  // root `/work/` and a target spelled `/work` are the same directory, and
  // testing the raw form misses it: `/work`.startsWith("/work/") is false, so the
  // carve-out on `/work/` would not cover `/work` and the path stays writable.
  if (target === normalizedRoot) return true
  return target.startsWith(normalizedRoot + "/") || target.startsWith(normalizedRoot + "\\")
}

/**
 * Roots the sandbox may write to, after applying `readOnlySubpaths`.
 *
 * A root that is entirely covered by a read-only carve-out drops out; one that is
 * only partly covered stays, because the carve-out is enforced separately and
 * must not silently widen.
 */
export function writableRootsAfterCarveOut(policy: FileSystemSandboxPolicy | undefined): string[] {
  const roots = policy?.writableRoots ?? []
  const readOnly = policy?.readOnlySubpaths ?? []
  return roots.filter((root) => !readOnly.some((ro) => isInside(root, ro)))
}

/**
 * True when writing to `target` is permitted.
 *
 * Exported so the in-process policy engine and the OS argument builders can be
 * proven to agree. If these two ever disagree, the policy screen says one thing
 * and the kernel enforces another, which is the exact failure the tests for the
 * old behaviour exist to prevent.
 */
export function canWrite(policy: FileSystemSandboxPolicy | undefined, target: string): boolean {
  if (policy === undefined) return false
  const roots = policy.writableRoots ?? []
  if (roots.length === 0) return false
  if ((policy.denyWritePaths ?? []).some((p) => isInside(target, p))) return false
  if ((policy.readOnlySubpaths ?? []).some((p) => isInside(target, p))) return false
  return roots.some((root) => isInside(target, root))
}

/** True when reading `target` is permitted. */
export function canRead(policy: FileSystemSandboxPolicy | undefined, target: string): boolean {
  if (policy === undefined) return false
  const roots = policy.writableRoots ?? []
  if (roots.length === 0) return false
  if ((policy.denyReadPaths ?? []).some((p) => isInside(target, p))) return false
  return roots.some((root) => isInside(target, root))
}

/* ------------------------------------------------------------------ *
 * Linux — bubblewrap
 * ------------------------------------------------------------------ */

/**
 * bubblewrap argument list.
 *
 * Replaces three broken shapes that were live in `spawn.ts`:
 * - `--unshare-all` dropped the network namespace unconditionally, ignoring a
 *   policy that allows network.
 * - `--net /dev/null` was never a bubblewrap option, so every network-disabled
 *   spawn died with "unknown option" instead of sandboxing.
 * - `--ro-bind cwd cwd` was immediately re-mounted by the following
 *   `--bind cwd cwd`, a dead mount pair that cancelled itself out.
 *
 * And it adds the enforcement that was missing entirely: the read/write mode of
 * the workspace bind is now derived from the policy instead of hardcoded.
 *
 * bubblewrap starts a sandbox with an EMPTY root unless something is bound, so
 * this must bind the read-only system directories or no command can run at all
 * (`bash` needs `/bin`, `/lib`, `/usr`). They are bound read-only, which is what
 * makes `--ro-bind / /` followed by writable overlays the correct construction:
 * the system is visible and immutable, and only the policy's roots are not.
 */
export function linuxSandboxArgs(
  command: string[],
  cwd: string,
  writableRoots: readonly string[],
  readOnlyRoots: readonly string[],
  disableNetwork: boolean,
  /** Open descriptor carrying an encoded seccomp filter, when one is installed. */
  seccompFd?: number,
  /** Extra mount flags, e.g. the `--tmpfs` pairs that hide credential stores. */
  extraFlags: readonly string[] = [],
): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    ...(disableNetwork ? ["--unshare-net"] : []),
    // `--seccomp` takes an open descriptor, not a path: bubblewrap has no way to
    // re-open the file, so a path would be a TOCTOU window between writing the
    // filter and bwrap reading it. Passing the descriptor means the bytes the
    // parent wrote are the bytes the child installs. bwrap does not close it.
    ...(seccompFd === undefined ? [] : ["--seccomp", String(seccompFd)]),
    ...extraFlags,
  ]

  // Read-only system roots first: everything else overlays on top of them.
  for (const root of readOnlyRoots) {
    args.push("--ro-bind", root, root)
  }

  // Writable roots overlay the read-only view. Duplicate binds of the same path
  // are how bubblewrap expresses an overlay, so a path appearing in both lists is
  // intentional and must NOT be de-duplicated.
  for (const root of writableRoots) {
    args.push("--bind", root, root)
  }

  args.push("--chdir", cwd, "--dev", "/dev", "--proc", "/proc")
  // The environment is passed through --setenv rather than inherited, so the
  // sandboxed process cannot read the parent's environment out of /proc. Without
  // this, `cat /proc/self/environ` inside the sandbox exposes every API key the
  // agent is holding, which defeats the isolation entirely.
  args.push("--clearenv")
  args.push(...command)
  return args
}

/** Default read-only system roots. Overridable so tests need no real filesystem. */
export const LINUX_SYSTEM_ROOTS: readonly string[] = ["/usr", "/bin", "/lib", "/lib64", "/etc"]

/* ------------------------------------------------------------------ *
 * macOS — Seatbelt
 * ------------------------------------------------------------------ */

/**
 * Escape a path for an SBPL string literal.
 *
 * SBPL strings are double-quoted and support backslash escapes, so an unescaped
 * quote or backslash in a workspace path would terminate the literal early and
 * splice attacker-influenced text into the policy. A workspace path containing
 * `"` is unusual but entirely constructible by a caller.
 */
export function sbplEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * SBPL profile for `sandbox-exec`.
 *
 * SBPL is last-match-wins, so the ORDER is the policy: allow the roots, then deny
 * everything, then re-allow the specific things that must stay available.
 * Getting this backwards is the classic seatbelt mistake — a trailing
 * `(allow default)` silently undoes every deny above it, which is exactly what
 * the previous `(allow default)`-only profile did.
 *
 * Deny-by-default is the point. The profile grants file-read and file-write
 * against the policy's roots and withholds everything else, so a `read-only`
 * session has no write capability anywhere on the host.
 */
export function seatbeltPolicyText(
  writableRoots: readonly string[],
  readOnlyRoots: readonly string[],
  disableNetwork: boolean,
  denyReadPaths: readonly string[] = [],
): string {
  const lines: string[] = ["(version 1)"]

  // Withhold first, then grant. Later rules win in SBPL.
  lines.push("(deny default)")

  if (disableNetwork) {
    // Network is denied wholesale. A domain allow-list cannot be expressed in
    // SBPL — it has no notion of a hostname — so the honest implementation of
    // "only these domains" is not available at this layer. Denying is the
    // fail-closed choice; `allowedDomains` is enforced by the proxy path.
    lines.push("(deny network*)")
  }

  // Read access to the system roots, never write. A shell that cannot read
  // /bin is useless, so these are granted read-only and nothing more.
  for (const root of readOnlyRoots) {
    lines.push(`(allow file-read* (subpath "${sbplEscape(root)}"))`)
  }

  for (const root of writableRoots) {
    lines.push(`(allow file-read* file-write* (subpath "${sbplEscape(root)}"))`)
  }

  // Deny wins over every grant above it, so a denied path is unreachable even if
  // it sits inside a writable root.
  for (const path of denyReadPaths) {
    lines.push(`(deny file-read* (subpath "${sbplEscape(path)}"))`)
  }

  // SBPL with no `allow default` denies a great deal that processes legitimately
  // need: process signalling, sysctl reads, mach lookups. Without these the
  // sandboxed process fails to start at all, which is a sandbox that is safe but
  // useless. These grant operations, never filesystem or network access.
  lines.push("(allow process-exec*)")
  lines.push("(allow signal (target self))")
  lines.push("(allow sysctl-read)")
  lines.push("(allow mach-lookup)")

  return lines.join("\n") + "\n"
}

/** Default read-only system roots for seatbelt. */
export const MACOS_SYSTEM_ROOTS: readonly string[] = ["/usr", "/bin", "/sbin", "/System", "/Library", "/etc", "/dev", "/private/var/db", "/private/etc"]
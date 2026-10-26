/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Credential storage.
 *
 * The gap this closes, measured on this machine
 * ---------------------------------------------
 * `auth.ts` protected its credential file with `fs.chmodSync(file, 0o600)` and
 * nothing else. On POSIX that is sufficient. On **Windows it is close to a
 * no-op**: the file keeps the ACL it inherited from its parent directory, and
 * `icacls` on a freshly created file in `%TEMP%` reported:
 *
 *   S-1-5-21-...-3854284612:(I)(M)      <- Modify, another principal
 *   S-1-15-2-...-4006411858:(I)(F)      <- Full control, AppContainer SID
 *   SKT\CodexSandboxUsers:(I)(M)        <- Modify, sandbox user group
 *   NT AUTHORITY\SYSTEM:(I)(F)
 *   BUILTIN\Administrators:(I)(F)
 *   SKT\engli:(I)(F)                    <- the owner
 *
 * So the mode bits said "owner only" while the ACL said "anyone in that sandbox
 * group can modify this, and an AppContainer SID has full control of it". After
 * `/inheritance:r /grant:r <user>:(R,W)` only `SKT\engli` remained. That is the
 * whole finding: the protection the code claimed and the protection the platform
 * actually applied were different things.
 *
 * Two backends, no native dependency
 * ----------------------------------
 * Codex uses the Rust `keyring` crate with platform-native backends. Nemo
 * has **zero** native dependencies, and adding one is a build-toolchain and
 * CI-matrix decision that is not an agent's to make unilaterally. So the OS
 * keychain backend here shells out to the tools the OS already ships:
 *
 *   Windows Credential Manager — `cmdkey` (limited: no arbitrary secrets)
 *   macOS Keychain             — `security`
 *   Linux Secret Service       — `secret-tool`
 *
 * and the DEFAULT backend is the hardened file store, which is what runs when no
 * keychain is available. The keychain backend is opt-in and the code degrades to
 * the file store rather than failing.
 *
 * The rule that matters most here
 * -------------------------------
 * A credential must never reach a log, an error message, or a diagnostic
 * string. Codex pins this with `error_display_tests.rs` — a `keyring::Error`
 * carries the credential payload inside it, so formatting the error with `{}`
 * prints the secret. Every error path here goes through `redactSecret`, and
 * `describe()` returns presence only, never the value.
 */

import { execFileSync } from "child_process"
import { randomBytes } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/** Where a credential was found. Reported instead of the credential. */
export type CredentialSource = "keychain" | "file" | "env" | "none"

export interface CredentialStore {
  /** The secret, or `undefined` when absent. */
  read(): string | undefined
  /** Persist the secret. */
  write(secret: string): void
  /**
   * Forget the secret.
   *
   * Must not make "logged in" distinguishable from "never logged in" by the
   * mere existence of a path, so the file is emptied rather than removed.
   */
  clear(): boolean
  /** Presence only. Never the value. */
  describe(): { present: boolean; source: CredentialSource }
}

/** Service/user label the keychain entry is filed under. */
export interface KeyringOptions {
  service: string
  account: string
  /** Injected for tests; defaults to the real implementations. */
  run?: (file: string, args: readonly string[], input?: string) => string
  platform?: NodeJS.Platform
}

/**
 * Remove anything that looks like a secret from a string.
 *
 * Applied to every error and every command's output before it can be surfaced.
 * It is a net, not a proof: the point is that a secret must never *rely* on
 * every future call site remembering to redact.
 */
export function redactSecret(text: string, secret?: string): string {
  let out = text
  if (secret !== undefined && secret.length >= 8) {
    // Exact match first: the most common leak is the value simply being in there.
    out = out.split(secret).join("[redacted]")
  }
  // Then shape-based, so a *different* secret is still caught: long opaque runs
  // that are not paths, flags, or URLs.
  out = out.replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[redacted]")
  return out
}

/** True on Windows, where the file mode is meaningless without an ACL. */
function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
}

/**
 * Restrict a file to the current user.
 *
 * On POSIX this is `chmod 0600`. On Windows it shells out to `icacls`, which is
 * present on every supported version, and does two things the mode bits cannot:
 * strips inherited ACEs (`/inheritance:r`) and grants only the owner
 * (`/grant:r`).
 *
 * `SYSTEM` and `Administrators` are deliberately left in place. Removing them
 * would lock an administrator out of the user's own credential file, which on
 * Windows is how "I cannot recover my profile" happens; they can already read it
 * regardless, so excluding them buys nothing.
 *
 * Returns false rather than throwing: a caller must still be able to report that
 * a credential was stored, with the caveat attached.
 */
export function restrictToOwner(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (isWindows(platform)) {
    try {
      const icacls = path.join(os.homedir() === "" ? "" : process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe")
      if (!fs.existsSync(icacls)) return false
      const who = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`
      if (who === "\\") return false
      execFileSync(icacls, [file, "/inheritance:r", "/grant:r", `${who}:(R,W)`], {
        stdio: "ignore",
        timeout: 10_000,
      })
      return true
    } catch {
      return false
    }
  }

  try {
    fs.chmodSync(file, 0o600)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * OS keychain
 * ------------------------------------------------------------------ */

/**
 * A credential store backed by the platform keychain.
 *
 * Every call throws a REDACTED error. The underlying tools can echo the value
 * they were given (`security -w <secret>` reports on success; a malformed call
 * can echo it back), so the output is scrubbed before it is allowed to become an
 * `Error` message.
 */
export function keychainStore(options: KeyringOptions): CredentialStore {
  const { service, account } = options
  const run =
    options.run ??
    ((file: string, args: readonly string[], input?: string): string =>
      execFileSync(file, [...args], {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      }))
  const platform = options.platform ?? process.platform

  /**
   * Runs a keychain command, redacting only what becomes an ERROR.
   *
   * Redacting the success path is a bug this module shipped into its first test
   * run: `read()` returned the literal string `[redacted]` instead of the
   * credential, because the secret IS the tool's successful output. The net
   * exists for error text, where the payload can leak through the formatting,
   * and it must not touch the value being returned to the caller.
   */
  const guard = (fn: () => string): string => {
    try {
      return fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`keychain operation failed: ${redactSecret(message)}`)
    }
  }

  return {
    read(): string | undefined {
      if (platform === "darwin") {
        const out = guard(() => run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]))
        const value = out.trim()
        return value.length > 0 ? value : undefined
      }
      if (platform === "linux") {
        const out = guard(() =>
          run("secret-tool", ["lookup", "service", service, "account", account], undefined),
        )
        const value = out.trim()
        return value.length > 0 ? value : undefined
      }
      throw new Error("no keychain backend for this platform")
    },

    write(secret: string): void {
      if (platform === "darwin") {
        // KNOWN LIMITATION: `security add-generic-password -w` takes the secret
        // as an ARGUMENT and has no stdin form, so the value appears in
        // /proc/<pid>/cmdline for the life of the call. There is no way around it
        // with the tool the OS ships, so it is stated rather than hidden.
        //
        // What limits the exposure: the argument exists for a few milliseconds,
        // and reading another process's cmdline requires the same user's rights.
        // A caller that cannot accept this should use the file store, which
        // writes the secret to a descriptor and never to a command line.
        guard(() => run("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]))
        return
      }
      if (platform === "linux") {
        // stdin, not argv — `secret-tool store` reads the secret from stdin, and
        // an argv secret is world-readable through /proc on Linux.
        guard(() => run("secret-tool", ["store", "--label", service, "service", service, "account", account], secret))
        return
      }
      throw new Error("no keychain backend for this platform")
    },

    clear(): boolean {
      try {
        if (platform === "darwin") {
          guard(() => run("security", ["delete-generic-password", "-s", service, "-a", account]))
          return true
        }
        if (platform === "linux") {
          guard(() => run("secret-tool", ["clear", "service", service, "account", account]))
          return true
        }
        return false
      } catch {
        // Nothing stored is not a failure worth surfacing; the caller's observable
        // state ("not logged in") is already correct.
        return false
      }
    },

    describe(): { present: boolean; source: CredentialSource } {
      let present = false
      try {
        present = this.read() !== undefined
      } catch {
        present = false
      }
      return { present, source: present ? "keychain" : "none" }
    },
  }
}

/** True when a keychain backend plausibly exists on this platform. */
export function keychainAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux"
}

/* ------------------------------------------------------------------ *
 * Hardened file store
 * ------------------------------------------------------------------ */

export interface FileStoreOptions {
  file: string
  platform?: NodeJS.Platform
  /** Injected so the ACL path can be asserted without touching a real ACL. */
  restrict?: (file: string, platform: NodeJS.Platform) => boolean
}

/**
 * A credential store backed by a file, restricted to the owner on every write.
 *
 * `write` is atomic via a temp file plus rename, and the restriction is applied
 * to the TEMP file before the rename — restricting after would leave a window in
 * which the credential sat at its final path with the inherited ACL.
 */
export function fileStore(options: FileStoreOptions): CredentialStore {
  const file = options.file
  const platform = options.platform ?? process.platform
  const restrict = options.restrict ?? restrictToOwner

  const writeFile = (secret: string): boolean => {
    // A random suffix, so the name is not predictable from the target path.
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
    let fd: number | undefined
    let renamed = false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body = JSON.stringify({ apiKey: secret, updatedAt: Date.now() }, null, 2)

      // O_EXCL is the symlink defence and it is not optional here. `writeFileSync`
      // on a PATH follows symlinks, and the temp name is predictable, so anyone
      // who can write into the credential directory could plant
      // `auth.json.tmp-<pid>` as a symlink and have the plaintext API key written
      // through it into a file of their choosing. O_CREAT|O_EXCL fails with EEXIST
      // when the path already exists — including when it exists as a symlink.
      fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)

      // Tighten the ACL BEFORE the secret bytes exist. Previously the order was
      // write-then-restrict, which left the plaintext key on disk under inherited
      // ACLs for the duration of the write — measured at six inheriting
      // principals on the development machine, one of which was a group with
      // modify rights.
      //
      // Its result is REPORTED rather than assumed: a credential written to a file
      // whose ACL could not be tightened is stored, but not protected, and
      // `write()` throws on a false return. Collapsing that to `true` would have
      // silently downgraded a failed restriction into a successful store.
      const secured = restrict(tmp, platform)

      fs.writeFileSync(fd, body, "utf8")
      fs.closeSync(fd)
      fd = undefined

      fs.renameSync(tmp, file)
      renamed = true
      // Re-assert on the final path: a rename can land on a directory whose ACL
      // differs from the one the temp file inherited.
      restrict(file, platform)
      return secured
    } catch {
      return false
    } finally {
      // The failure paths are the ones that mattered: `restrict` or `renameSync`
      // throwing used to leave `<file>.tmp-<pid>` on disk holding the plaintext
      // secret, with whatever ACL the directory default gave it and no way to
      // find it later. Now the temp is removed on every path that did not become
      // the final file.
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* already closed */
        }
      }
      if (!renamed) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* never created */
        }
      }
    }
  }

  return {
    read(): string | undefined {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { apiKey?: unknown }
        if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) return undefined
        return raw.apiKey
      } catch {
        return undefined
      }
    },

    write(secret: string): void {
      if (!writeFile(secret)) throw new Error("could not store credential")
    },

    clear(): boolean {
      // Emptied, not deleted: removing the file makes "logged in" and "never
      // logged in" distinguishable by stat alone.
      //
      // Reports FALSE when the file is absent, because "was logged in and just
      // logged out" and "was never logged in" are different facts and the caller
      // has to be able to tell them apart. Writing an empty file into a path that
      // did not exist would report success for clearing a credential that was
      // never there.
      if (!fs.existsSync(file)) return false
      return writeFile("")
    },

    describe(): { present: boolean; source: CredentialSource } {
      const present = this.read() !== undefined
      return { present, source: present ? "file" : "none" }
    },
  }
}

/**
 * Pick the best available store: keychain when one plausibly exists, hardened
 * file otherwise.
 *
 * Deliberately does NOT probe the keychain by attempting a read. A `security` or
 * `secret-tool` invocation can block on a prompt or take seconds, and a startup
 * path must never do that; the choice is made from the platform alone and the
 * caller can force the file store.
 */
export function bestCredentialStore(options: {
  file: string
  service: string
  account: string
  /** Force the file store regardless of platform. */
  preferFile?: boolean
}): CredentialStore {
  if (options.preferFile === true || !keychainAvailable()) {
    return fileStore({ file: options.file })
  }
  return keychainStore({ service: options.service, account: options.account })
}
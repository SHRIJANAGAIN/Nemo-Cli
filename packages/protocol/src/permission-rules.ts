/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Permission ruleset engine (ported from Shrijan Code's permission system).
 *
 * Layers, highest precedence first:
 *   1. full-access mode — nothing blocks, everything is allowed. The user
 *                        explicitly asked to run unguarded.
 *   2. session rules   — "always/never for this session", in-memory
 *   3. config rules    — rulesV2, persisted in the user's config
 *   4. legacy rules    — the original {tool, pattern, allow} defaults
 *   5. force-ask rules — destructive operations that require a human even
 *                        under auto-approve (bypassed only by full-access)
 *   6. UI mode         — read-only | ask | auto-approve | full-access
 *
 * Within layers 2–4, deny beats allow (hard veto). Full-access skips all
 * layers. In auto-approve, only DELETE-family operations can still ask —
 * everything else auto-allows.
 */

import {
  DEFAULT_PERMISSIONS,
  READ_ONLY_TOOLS,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
  type PermissionRuleV2,
  type PermissionUIMode,
} from "./permissions.js"

export type PermissionLayer = "session" | "config" | "default" | "force-ask" | "mode"

export type PermissionSource =
  "deny-rule" | "allow-rule" | "force-ask" | "read-only-mode" | "plan-mode" | "read-only-tool" | "mode" | "default"

export interface PermissionDecision {
  action: PermissionAction
  source: PermissionSource
  /** The rule that produced the decision, when a rule matched. */
  rule?: PermissionRuleV2
  layer?: PermissionLayer
}

/**
 * Operations that always require interactive approval — even under
 * auto-approve mode. Only an explicit full-access (YOLO) toggle bypasses
 * these, and a user can consciously allow-list them via config rules.
 */
export const FORCE_ASK_RULES: ReadonlyArray<PermissionRuleV2> = [
  // ── recursive / forced delete ───────────────────────────���─────────────
  { tool: "*", pattern: "rm -rf", action: "ask", reason: "recursive force delete" },
  { tool: "*", pattern: "rm -fr", action: "ask", reason: "recursive force delete" },
  { tool: "*", pattern: "del /s /q", action: "ask", reason: "recursive delete (Windows)" },
  // Flag ORDER variants: `del /f /s /q` is the same destructive operation as
  // `del /s /q`, but substring matching is order-sensitive, so the canonical
  // entry alone let the common Windows form through unnoticed (audit #24).
  { tool: "*", pattern: "del /f /s /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "del /s /f /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "del /q /s", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "Remove-Item -Recurse -Force", action: "ask", reason: "recursive delete (PowerShell)" },
  { tool: "*", pattern: "Remove-Item -Force -Recurse", action: "ask", reason: "recursive delete (PowerShell)" },
  // PowerShell accepts the path BEFORE the switch list, and that ordering is
  // what a human writes: `Remove-Item C:\Windows\System32\config -Recurse
  // -Force` (which destroys the offline registry hives) matched neither rule
  // above and returned `allow` under auto-approve. Globs rather than literals
  // because the path is arbitrary.
  { tool: "*", pattern: "Remove-Item * -Recurse -Force", action: "ask", reason: "recursive delete (PowerShell)" },
  { tool: "*", pattern: "Remove-Item * -Force -Recurse", action: "ask", reason: "recursive delete (PowerShell)" },
  { tool: "*", pattern: "rmdir /s", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "rd /s /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "rd /q /s", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "find / -delete", action: "ask", reason: "recursive delete" },
  // `find` deletes whatever its predicate matches, from any starting point —
  // `find / -delete` alone gated the absolute-root spelling and let the far
  // more common `find . -name '*.log' -delete` through. `-exec rm`/`unlink`
  // are the same operation spelled with a sub-command instead of `-delete`.
  { tool: "*", pattern: "find * -delete", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "find * -exec rm", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "find * -exec unlink", action: "ask", reason: "recursive delete" },
  // Order matters for a SUBSTRING matcher and `*` cannot match an empty string
  // (measured: `git clean *f*d*` fails on `-xdf`, because nothing sits between
  // the `f` and the `d`). So the force/directory combinations are listed
  // explicitly rather than papered over with one clever glob. `git clean -n`
  // (dry run, destroys nothing) is deliberately absent.
  { tool: "*", pattern: "git clean *f*d*", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -xdf", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -d -f", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -f -d", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean --dir --force", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean --force --dir", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -fdx", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -fd", action: "ask", reason: "recursive delete" },

  // ── privilege escalation ─────────────────────────────────────────────
  { tool: "*", pattern: "sudo ", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "su -", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "doas ", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "runas ", action: "ask", reason: "privilege escalation (Windows)" },
  { tool: "*", pattern: "Start-Process -Verb RunAs", action: "ask", reason: "privilege escalation (PowerShell)" },

  // ── system power / reboot ───────────────────────────────────────────
  { tool: "*", pattern: "shutdown", action: "ask", reason: "system power" },
  { tool: "*", pattern: "reboot", action: "ask", reason: "system power" },
  { tool: "*", pattern: "poweroff", action: "ask", reason: "system power" },
  { tool: "*", pattern: "halt ", action: "ask", reason: "system power" },
  { tool: "*", pattern: "Stop-Computer", action: "ask", reason: "system power (PowerShell)" },
  { tool: "*", pattern: "systemctl poweroff", action: "ask", reason: "system power" },
  { tool: "*", pattern: "systemctl reboot", action: "ask", reason: "system power" },
  // Same family: switches the machine's boot target out from under every
  // running process, which is the availability consequence `halt` has.
  { tool: "*", pattern: "systemctl isolate", action: "ask", reason: "system power" },

  // ── filesystem / disk destruction ───────────────────────────────────
  { tool: "*", pattern: "mkfs", action: "ask", reason: "filesystem format" },
  { tool: "*", pattern: "format ", action: "ask", reason: "disk format" },
  { tool: "*", pattern: "format.com", action: "ask", reason: "disk format (Windows)" },
  { tool: "*", pattern: "dd if=", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "of=/dev/", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "> /dev/sd", action: "ask", reason: "raw disk write" },
  // Same destruction as `dd of=/dev/sd`, reached through the dedicated
  // block-device tools: `wipefs` erases filesystem/partition signatures so the
  // disk reads as empty, `blkdiscard` zeroes every block. Both leave the device
  // present but its contents unrecoverable, which is exactly the class the
  // `dd` patterns above already gate. Measured returning `allow` under
  // `--ui-mode auto-approve`.
  { tool: "*", pattern: "wipefs", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "blkdiscard", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "fdisk", action: "ask", reason: "partition table write" },
  { tool: "*", pattern: "parted", action: "ask", reason: "partition table write" },
  { tool: "*", pattern: "diskpart", action: "ask", reason: "partition table write (Windows)" },
  { tool: "*", pattern: "shred ", action: "ask", reason: "irreversible erase" },
  { tool: "*", pattern: "chmod -R 777", action: "ask", reason: "permission destruction" },
  { tool: "*", pattern: "chmod 777 /", action: "ask", reason: "permission destruction" },
  { tool: "*", pattern: "chown -R", action: "ask", reason: "ownership rewrite" },
  { tool: "*", pattern: "takeown", action: "ask", reason: "ownership rewrite (Windows)" },
  { tool: "*", pattern: "icacls", action: "ask", reason: "ACL rewrite (Windows)" },
  { tool: "*", pattern: "reg delete", action: "ask", reason: "registry deletion" },
  { tool: "*", pattern: "vssadmin", action: "ask", reason: "shadow copy deletion" },
  { tool: "*", pattern: "wmic shadowcopy delete", action: "ask", reason: "shadow copy deletion" },

  // ── force push / history rewriting ──────────────────────────────────
  { tool: "*", pattern: "git push --force", action: "ask", reason: "force push" },
  { tool: "*", pattern: "git push -f", action: "ask", reason: "force push" },
  // Remote ref DESTRUCTION. Same hazard the force-push rules above already gate
  // ("no local reflog can bring them back" — everyone who cloned has them), and
  // `--mirror` is strictly worse than `--force`: it deletes every ref on the
  // remote that has no local counterpart, not just the one being overwritten.
  // These were measured returning `allow` under `--ui-mode auto-approve`.
  // Ordered ahead of the plain `git push origin` rule so the specific
  // destructive form is the one reported, not the generic one.
  { tool: "*", pattern: "git push --mirror", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push --delete", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push -d", action: "ask", reason: "remote ref destruction" },
  // A refspec is destructive by its first character: `:` deletes the named
  // remote ref, `+` force-overwrites it. Matched with a glob rather than a
  // literal remote name, because the destructive refspec may sit on either side
  // of the remote (`git push origin :x` and `git push upstream :x` are the same
  // hazard, and no remote name is privileged), and because the delete flag can
  // follow the remote (`git push origin --delete x`) as well as precede it.
  { tool: "*", pattern: "git push * :*", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push * +*", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push * --delete*", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push * -d *", action: "ask", reason: "remote ref destruction" },
  { tool: "*", pattern: "git push origin", action: "ask", reason: "remote mutation" },
  { tool: "*", pattern: "git reset --hard", action: "ask", reason: "discard working tree" },
  { tool: "*", pattern: "git filter-branch", action: "ask", reason: "history rewrite" },
  { tool: "*", pattern: "git update-ref -d", action: "ask", reason: "history rewrite" },

  // ── pipe-to-shell / remote code execution ───────────────────────────
  { tool: "*", pattern: " | sh", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: " | bash", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: "|zsh", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: "|python", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "|node", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "| perl", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "| ruby", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "iex ", action: "ask", reason: "PowerShell Invoke-Expression download" },
  { tool: "*", pattern: "Invoke-Expression", action: "ask", reason: "PowerShell Invoke-Expression download" },
  { tool: "*", pattern: "iwr ", action: "ask", reason: "PowerShell web request download" },
  { tool: "*", pattern: "Invoke-WebRequest", action: "ask", reason: "PowerShell web request download" },
  { tool: "*", pattern: "wget http", action: "ask", reason: "remote download" },
  { tool: "*", pattern: "curl http", action: "ask", reason: "remote download" },
  { tool: "*", pattern: "eval(", action: "ask", reason: "dynamic evaluation" },

  // ── anti-forensics / evidence destruction ───────────────────────────
  { tool: "*", pattern: "history -c", action: "ask", reason: "shell history erasure" },
  { tool: "*", pattern: "> .bash_history", action: "ask", reason: "shell history erasure" },
  { tool: "*", pattern: "Clear-Content", action: "ask", reason: "log truncation (PowerShell)" },
  { tool: "*", pattern: "> /var/log", action: "ask", reason: "system log truncation" },
  { tool: "*", pattern: "truncate -s 0", action: "ask", reason: "file truncation" },
  { tool: "*", pattern: "Remove-Message", action: "ask", reason: "audit log deletion (PowerShell)" },
  { tool: "*", pattern: "wevtutil cl", action: "ask", reason: "audit log deletion (Windows)" },

  // ── irreversible data / infrastructure loss ─────────────────────────
  { tool: "*", pattern: "DROP DATABASE", action: "ask", reason: "database destruction" },
  { tool: "*", pattern: "DROP TABLE", action: "ask", reason: "table destruction" },
  { tool: "*", pattern: "TRUNCATE TABLE", action: "ask", reason: "table destruction" },
  // `DELETE FROM <t>` with no WHERE clause empties a table exactly as TRUNCATE
  // does, and the WHERE-less form is the one an agent emits when it means
  // "clear this out". Measured returning `allow` under `--ui-mode auto-approve`.
  { tool: "*", pattern: "DELETE FROM", action: "ask", reason: "table destruction" },
  { tool: "*", pattern: "db.dropDatabase", action: "ask", reason: "database destruction" },
  { tool: "*", pattern: "DROP SCHEMA", action: "ask", reason: "schema destruction" },
  { tool: "*", pattern: "docker system prune", action: "ask", reason: "container destruction" },
  { tool: "*", pattern: "docker volume rm", action: "ask", reason: "volume destruction" },
  { tool: "*", pattern: "terraform destroy", action: "ask", reason: "infrastructure destruction" },
  { tool: "*", pattern: "terraform apply", action: "ask", reason: "infrastructure mutation" },
  { tool: "*", pattern: "kubectl delete", action: "ask", reason: "cluster destruction" },
  { tool: "*", pattern: "aws s3 rb", action: "ask", reason: "cloud storage destruction" },
  // Object-level deletion, which `aws s3 rb` (bucket removal) does not cover.
  // `aws s3 rm s3://bucket --recursive` empties the bucket and
  // `aws s3 sync s3://bucket . --delete` prunes every object absent from the
  // local source. Unrecoverable for everyone else using the bucket, the same
  // argument that gates the git remote-ref rules. Measured returning `allow`.
  { tool: "*", pattern: "aws s3 rm", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "aws s3 sync", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "az storage blob delete", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "gsutil rm -r", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "az storage delete", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "helm delete", action: "ask", reason: "cluster destruction" },
  { tool: "*", pattern: "DROP VOLUME", action: "ask", reason: "volume destruction" },

  // ── credential / secret access ─────────────────────────────────────
  { tool: "*", pattern: "cat ~/.ssh", action: "ask", reason: "private key read" },
  { tool: "*", pattern: "cat /etc/shadow", action: "ask", reason: "credential read" },
  { tool: "*", pattern: "cat .aws/credentials", action: "ask", reason: "cloud credential read" },
  { tool: "*", pattern: "printenv", action: "ask", reason: "environment dump" },
  { tool: "*", pattern: "env | grep", action: "ask", reason: "environment dump" },
  { tool: "*", pattern: "setx", action: "ask", reason: "persistent env mutation (Windows)" },
  // Publishing a package is a one-way door for consumers: `npm unpublish` is
  // refused after 72 hours or 300 downloads, so a version that shipped broken
  // stays shipped. Deliberate, infrequent, and never something a build or test
  // command does incidentally.
  { tool: "*", pattern: "npm publish", action: "ask", reason: "package publication" },
  { tool: "*", pattern: "npm unpublish", action: "ask", reason: "package publication" },
  { tool: "*", pattern: "cargo publish", action: "ask", reason: "package publication" },
  { tool: "*", pattern: "twine upload", action: "ask", reason: "package publication" },
]

/**
 * Irreversible-action subset of FORCE_ASK_RULES — the rules that still gate
 * a tool call under auto-approve mode.
 *
 * Auto-approve exists to stop *routine* work from prompting, not to hand the
 * agent a blank cheque. So the gate covers every action whose damage is
 * unrecoverable or unauditable: deleting data, destroying infrastructure,
 * erasing evidence, and executing code that has not been read yet.
 *
 * Deliberately NOT in this set (they still ask in the default `ask` mode, but
 * auto-approve lets them through because they are recoverable or routine):
 *   - privilege escalation (`sudo`, `doas`, `runas`) — noisy, and the
 *     escalation itself fails without real credentials;
 *   - `git reset --hard` — recoverable from the reflog;
 *   - permission churn (`chmod`/`chown`/`icacls` outside the delete families).
 *     Note that raw disk writes are gated more broadly than this list implies:
 *     the `dd if=` rule matches on the READ side, so EVERY `dd` asks under
 *     auto-approve, including benign ones like `dd if=/dev/zero of=./disk.img`.
 *     That over-gate predates this audit and is left alone deliberately —
 *     narrowing it means parsing argv, and a spurious prompt is the safe
 *     direction. Anything aimed at a whole device (`of=/dev/…`, `wipefs`,
 *     `blkdiscard`) IS in this set via the `raw disk write` reason;
 *   - credential *reads* (`cat ~/.ssh/id_rsa`, `printenv`) — these are
 *     read-only, and the network-deny sandbox plus secret redaction are the
 *     controls that actually limit exfiltration.
 *
 * full-access mode bypasses the whole set by explicit user choice.
 */
export const IRREVERSIBLE_FORCE_ASK_REASONS: ReadonlySet<string> = new Set([
  // deletion
  "recursive force delete",
  "recursive delete (Windows)",
  "recursive delete (PowerShell)",
  // Plain-POSIX deletion. Its three siblings are already in this set, so its
  // absence was an oversight rather than a decision: `find / -delete`,
  // `git clean -fdx` and `git clean -fd` were measured returning `allow` under
  // auto-approve. `git clean -fdx` in particular discards every untracked file
  // in the worktree, which is unrecoverable and easy to run by accident.
  "recursive delete",
  // Windows disk format. `format ` (reason "disk format") was already gated and
  // AGENTS.md names `format` in the always-ask list, but `format.com` — the
  // form cmd.exe actually dispatches to — carried its own reason string and was
  // therefore never gated. Formatting a volume destroys it.
  "disk format (Windows)",
  "disk format",
  "filesystem format",
  "partition table write",
  "partition table write (Windows)",
  "raw disk write",
  "database destruction",
  "table destruction",
  "schema destruction",
  "volume destruction",
  "container destruction",
  "infrastructure destruction",
  "cluster destruction",
  "cloud storage destruction",
  "irreversible erase",
  "permission destruction",
  "registry deletion",
  "shadow copy deletion",
  "audit log deletion (PowerShell)",
  "audit log deletion (Windows)",
  "shell history erasure",
  "system log truncation",
  "log truncation (PowerShell)",
  "file truncation",
  "ownership rewrite",
  "ownership rewrite (Windows)",
  "ACL rewrite (Windows)",
  "pipe-to-shell download",
  "pipe-to-interpreter",
  "PowerShell web request download",
  "PowerShell Invoke-Expression download",
  "remote download",
  "dynamic evaluation",
  "persistent env mutation (Windows)",
  // Remote history rewrite. Listed here even though it was previously grouped
  // with `git reset --hard` as "recoverable from the reflog": that is true
  // only for the LOCAL branch. A force push overwrites the remote branch, and
  // the commits it removed are gone for everyone who had cloned it — no local
  // reflog can bring them back, so it is not recoverable in the sense the
  // rest of this list uses. A plain `git push origin feature/x` stays
  // auto-approved; that is routine work.
  "force push",
  // Deleting a remote ref outright. Identical reasoning to the force push above,
  // and for the same reason it was moved here: once the branch or tag is gone
  // from the remote it is gone for every collaborator, and no local reflog
  // restores it. `git push --mirror` is the broad form — it removes every remote
  // ref that has no local counterpart.
  "remote ref destruction",
  // Host availability. `shutdown`, `reboot`, `poweroff`, `halt`, `Stop-Computer`
  // and the systemctl power verbs were all already ASK rules, but their reason
  // was absent from this set — and a force-ask rule whose reason is missing here
  // is not in DELETE_FORCE_ASK_RULES, so it does not gate at all under
  // auto-approve. Measured: `shutdown /s /t 0` returned `allow`, contradicting
  // AGENTS.md, which names `shutdown` in the list of operations that "always
  // resolve to `ask` unless danger mode is explicit". Tearing down a machine the
  // agent is running on is unrecoverable from inside the session either way.
  "system power",
  "system power (PowerShell)",
  // A published version cannot be recalled once consumers have installed it.
  "package publication",
])

/**
 * Delete-family subset of FORCE_ASK_RULES, retained under its original name
 * because it is the historical export. In auto-approve mode ONLY these can
 * still gate a tool call — every other sensitive operation auto-allows.
 */
export const DELETE_FORCE_ASK_RULES: ReadonlyArray<PermissionRuleV2> = FORCE_ASK_RULES.filter((r) =>
  IRREVERSIBLE_FORCE_ASK_REASONS.has(r.reason ?? ""),
)

/* ────────────────────────── session rule store ────────────────────────── */

let sessionRules: PermissionRuleV2[] = []

/** Add an in-memory rule that lives for this process/session only. */
export function addSessionPermissionRule(rule: PermissionRuleV2): void {
  // Later session decisions for the same tool+pattern replace earlier ones.
  sessionRules = sessionRules.filter((r) => !(r.tool === rule.tool && (r.pattern ?? "*") === (rule.pattern ?? "*")))
  sessionRules.unshift(rule)
}

export function clearSessionPermissionRules(): void {
  sessionRules = []
}

export function getSessionPermissionRules(): ReadonlyArray<PermissionRuleV2> {
  return sessionRules
}

/* ───────────────────────────── matching ───────────────────────────── */

/**
 * Linear-time glob matcher (round 13). The old `globToRegExp` compiled
 * `*`→`.*` and ran it against untrusted subjects on the permission hot
 * path — a rule with a dozen stars vs a long non-matching command/path
 * was catastrophic backtracking (ReDoS). This is the classic greedy
 * matcher: O(pattern × text) worst case, NEVER exponential, and it
 * reproduces the old RegExp semantics exactly:
 *   - `*` = any run except "\n" (`.*` without the s-flag),
 *   - `?` is literal unless `singleChar` is set (protocol globs never
 *     treated it as a wildcard; sandbox rules do),
 *   - `caseInsensitive` folds like the old `i` flag,
 *   - `unanchored` = the old body-only (no `^…$`) pattern, i.e. `*`+p+`*`.
 */
export function globMatch(
  pattern: string,
  text: string,
  opts: { caseInsensitive?: boolean; singleChar?: boolean; unanchored?: boolean } = {},
): boolean {
  const p = opts.unanchored ? `*${pattern}*` : pattern
  const s = text
  // A `\n` in the text is only ever consumable by a literal `\n` in the
  // pattern — wildcards never cross it (mirrors `.` without s-flag).
  if (s.includes("\n") && !p.includes("\n")) return false
  const fold = (v: string): string => (opts.caseInsensitive === true ? v.toLowerCase() : v)
  const fp = fold(p)
  const fs = fold(s)
  const ok = (pc: string, sc: string): boolean => pc === sc || (sc !== "\n" && opts.singleChar === true && pc === "?")
  let pi = 0
  let si = 0
  let starPi = -1
  let starSi = -1
  while (si < fs.length) {
    if (pi < fp.length && fp[pi] === "*") {
      starPi = pi
      starSi = si
      while (pi + 1 < fp.length && fp[pi + 1] === "*") pi++ // coalesce runs
      pi++
      continue
    }
    if (pi < fp.length && ok(fp[pi]!, fs[si]!)) {
      pi++
      si++
      continue
    }
    if (starPi !== -1) {
      // Let the recorded star consume one more char — but never a "\n": a
      // wildcard is `.` without the s-flag, so it can only match a newline if
      // the pattern has a literal one.
      //
      // Running off the END of the text is NOT a failure. A trailing `*` may
      // legitimately match zero further characters, and whether the whole match
      // succeeds is decided by the loop exit plus the tail check below.
      // Rejecting here instead made every unanchored pattern whose expansion
      // reaches the last character fail to match — which silently disarmed the
      // whole force-ask layer: `unanchored` rewrites the pattern to `*p*`, so
      // `rm -rf` against `rm -rf /tmp/x` expanded its trailing `*` to the end of
      // the subject and returned false. Every destructive command (and every
      // deny rule) that needed its wildcard to reach the end of the string
      // stopped matching, and auto-approve mode then ran `rm -rf` with no prompt.
      if (fs[starSi] === "\n") return false
      starSi++
      si = starSi
      pi = starPi + 1
      continue
    }
    return false
  }
  while (pi < fp.length && fp[pi] === "*") pi++
  return pi === fp.length
}

function matchTool(tool: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true
  if (pattern.includes("*")) return globMatch(pattern, tool, { caseInsensitive: true })
  return pattern.toLowerCase() === tool.toLowerCase()
}

function matchSubject(subject: string, pattern?: string): boolean {
  if (!pattern || pattern === "*") return true
  // Windows subjects use `\` while rules are written with `/`. Normalize
  // BOTH sides (#84) or `**/secrets/**` silently never fires against
  // `C:\proj\secrets\key` — a deny rule that matches nothing. Case
  // insensitivity is the old `i` flag: globMatch folds both sides.
  return globMatch(pattern.replace(/\\/g, "/"), subject.replace(/\\/g, "/"), {
    caseInsensitive: true,
    unanchored: true,
  })
}

/**
 * Extract a human-friendly subject from tool arguments — the shell command,
 * the file path, the URL … Falls back to the JSON serialization.
 */
export function permissionSubject(args: unknown): string {
  if (typeof args === "string") return args
  if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>
    // Ordered most-specific first; `name`/`target` sit last so they only
    // pick the subject when nothing concrete matched (#85) — otherwise the
    // JSON-blob fallback let a rule pattern match against an unrelated
    // field of the same args object (false allow/deny).
    for (const key of ["command", "path", "file_path", "filePath", "url", "query", "pattern", "name", "target"]) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) return value
    }
    try {
      return JSON.stringify(args) ?? ""
    } catch {
      return String(args)
    }
  }
  return args == null ? "" : String(args)
}

function legacyToRules(rules: readonly PermissionRule[]): PermissionRuleV2[] {
  return rules.map((r) => ({
    tool: r.tool,
    pattern: r.pattern,
    action: r.allow ? ("allow" as const) : ("deny" as const),
  }))
}

function deriveUIMode(config: PermissionConfig): PermissionUIMode {
  if (config.uiMode) return config.uiMode
  // Legacy YOLO (mode "yolo" or askByDefault=false) ≈ auto-approve; deny
  // rules and force-ask still protect the user.
  if (config.mode === "yolo" || config.askByDefault === false) return "auto-approve"
  return "ask"
}

/**
 * `READ_ONLY_TOOLS` entries whose tool name alone does not mean "reads only".
 *
 * `memory`, `todo`, and `artifact` are multi-action: each exposes read
 * actions alongside actions that create, overwrite, or delete files on disk
 * (`memory.save` -> `~/.nemo/memory/memory.json`; `todo.write` ->
 * `~/.nemo/todos/`; `artifact.create` -> `<cwd>/nemo/10-upload/artifacts/`
 * — and its manager even `mkdirSync`s in the constructor). The read-only gate
 * used to match on the tool NAME alone, so `artifact create` was `allow` in
 * read-only mode and really did write `1.json` + `manifest.json` into the
 * project. "Read-only" has to mean read-only, so the gate is now action-aware
 * for exactly these three: the listed actions still pass, every other action
 * is denied.
 *
 * Keep in sync with each tool's `action` enum — `memory` (memory.ts),
 * `todo` (todo.ts), `artifact` (artifact.ts).
 */
const READ_ONLY_TOOL_SAFE_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["memory", new Set(["search", "list"])],
  ["todo", new Set(["read"])],
  ["artifact", new Set(["get", "list", "search"])],
])

/**
 * Whether a `READ_ONLY_TOOLS` member may run in read-only/plan mode.
 *
 * Fail-closed at execution time: an action that is missing, not a string, or
 * not in the safe set is treated as a write, so a malformed call cannot slip
 * past by omitting `action`. The one exception is `args === undefined`, which
 * is the agent loop's catalogue-listing call (`agent-loop.ts` filters tools
 * before a model can choose arguments) — there the action is genuinely
 * unknown, and denying would hide the tool's READ half from the model instead
 * of protecting anything.
 */
function isReadOnlyAllowed(tool: string, args: unknown): boolean {
  const safe = READ_ONLY_TOOL_SAFE_ACTIONS.get(tool)
  if (!safe) return true
  if (args === undefined) return true
  const action = (args as { action?: unknown } | null)?.action
  return typeof action === "string" && safe.has(action)
}

/* ─────────────────────────── evaluation ─────────────────────────── */

/**
 * Decide whether a tool call is allowed, must be asked about, or is denied.
 *
 * @param tool   tool name (e.g. "bash", "write_file")
 * @param args   raw tool arguments (or a pre-extracted subject string)
 * @param config effective permission config; defaults to DEFAULT_PERMISSIONS
 */
export function evaluatePermission(
  tool: string,
  args: unknown,
  config: PermissionConfig = DEFAULT_PERMISSIONS,
  options?: { uiMode?: PermissionUIMode },
): PermissionDecision {
  const subject = permissionSubject(args)
  const uiMode = options?.uiMode ?? deriveUIMode(config)

  // 0) Full-access: nothing blocks, everything is allowed. The user
  //    explicitly chose to run unguarded — no rule layer applies.
  if (uiMode === "full-access") {
    return { action: "allow", source: "mode", layer: "mode" }
  }

  // 1) Rule layers, highest precedence first: session > config > default.
  //    Within a layer, deny beats allow (hard veto). A higher layer's
  //    explicit allow can therefore override a lower layer's default deny —
  //    that is exactly what "always allow" is for.
  //    Auto-approve skips the STOCK default layer: the user accepted risk
  //    for everything except deletes, but their own session/config rules
  //    stay sacred and still gate.
  const layers: Array<[PermissionLayer, PermissionRuleV2[]]> =
    uiMode === "auto-approve"
      ? [
          ["session", [...sessionRules]],
          ["config", [...(config.rulesV2 ?? [])]],
        ]
      : [
          ["session", [...sessionRules]],
          ["config", [...(config.rulesV2 ?? [])]],
          ["default", legacyToRules(config.rules ?? [])],
        ]
  const matches = (rule: PermissionRuleV2): boolean => matchTool(tool, rule.tool) && matchSubject(subject, rule.pattern)

  // Force-ask pool, resolved up front. A destructive command must land on `ask`
  // even when an allow rule matches it: `bash(*)` — or a plan-exit rule the
  // model itself proposed — used to short-circuit here and run `rm -rf /` with
  // no prompt at all. AGENTS.md is unconditional on this ("Destructive commands
  // always resolve to `ask` unless danger mode is explicit"), and full-access
  // already returned allow at step 0, so danger mode keeps its exception.
  // In auto-approve only delete-family operations gate, which is what that mode
  // already documented.
  const forcePool = uiMode === "auto-approve" ? DELETE_FORCE_ASK_RULES : FORCE_ASK_RULES
  const forced = (): PermissionRuleV2 | undefined =>
    forcePool.find((r) => matchTool(tool, r.tool) && matchSubject(subject, r.pattern))

  for (const [layer, rules] of layers) {
    const deny = rules.find((r) => r.action === "deny" && matches(r))
    if (deny) return { action: "deny", source: "deny-rule", rule: deny, layer }
    const allow = rules.find((r) => r.action === "allow" && matches(r))
    if (allow) {
      // Deny lists win over allow lists, and a destructive command is never
      // unlocked by "always allow".
      const force = forced()
      if (force) return { action: "ask", source: "force-ask", rule: force, layer: "force-ask" }
      return { action: "allow", source: "allow-rule", rule: allow, layer }
    }
  }

  // 2) Read-only & plan mode: mutating tools are denied outright (and
  //    hidden from the model); only known-safe read-only tools pass.
  //    Shrijan's plan mode is exactly this deny-list — the agent can explore
  //    but never modify — plus plan instructions appended to the system
  //    prompt by the agent loop, so it produces a plan for approval.
  if (uiMode === "read-only" || uiMode === "plan") {
    return READ_ONLY_TOOLS.has(tool) && isReadOnlyAllowed(tool, args)
      ? { action: "allow", source: "read-only-tool", layer: "mode" }
      : { action: "deny", source: uiMode === "plan" ? "plan-mode" : "read-only-mode", layer: "mode" }
  }

  // 3) Read-only tools never need approval.
  if (READ_ONLY_TOOLS.has(tool)) {
    return { action: "allow", source: "read-only-tool" }
  }

  // 5) Force-ask: in auto-approve mode ONLY delete-family operations can
  //    still gate a call — everything else auto-allows. (Full-access never
  //    reaches here: it returns allow at step 0. A matched allow rule already
  //    consulted the same pool above, so this only sees commands no rule
  //    allowed.)
  const force = forced()
  if (force) {
    return { action: "ask", source: "force-ask", rule: force, layer: "force-ask" }
  }

  // 6) Mode defaults. (Full-access never reaches here: step 0.)
  if (uiMode === "auto-approve") {
    return { action: "allow", source: "mode", layer: "mode" }
  }

  // 7) Ask mode (the default).
  return { action: "ask", source: "default", layer: "mode" }
}

/** True when the tool must never be executed (also used to hide tools from the model). */
export function isPermissionDenied(
  tool: string,
  args: unknown,
  config?: PermissionConfig,
  options?: { uiMode?: PermissionUIMode },
): boolean {
  return evaluatePermission(tool, args, config, options).action === "deny"
}

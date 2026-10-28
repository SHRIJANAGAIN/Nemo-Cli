/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Automatic issue fixing — the bot watches labeled issues and opens PRs.
 *
 * Safety design (read before relaxing anything):
 * - LABEL-GATED: only open issues carrying GITHUB_AUTOFIX_LABEL (default
 *   `nemo`) are touched. A human applies the label = intent, same as
 *   typing /nemo. unlabeled issues are invisible to the poller.
 * - PRs, NEVER direct main commits: every fix lands on
 *   `nemo/issue-N` and opens a pull request. A human merges.
 * - ONE issue per tick, jobs serialized server-wide: the 1GB VPS cannot
 *   survive concurrent agent runs.
 * - LEDGER: an issue number runs once ever (repo#num → PR url). Retry by
 *   commenting /nemo (the manual path ignores the ledger).
 * - REPO ALLOWLIST: GITHUB_AUTOFIX_REPOS="owner/a,owner/b". Empty = poller
 *   idle (logged once at boot). No allowlist, no surprises.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface AutofixCandidate {
  repo: string
  number: number
  title: string
}

export interface AutofixLedgerEntry {
  at: string
  prUrl?: string
}

/** "owner/a, owner/b" → ["owner/a", "owner/b"]. "*" (alone or mixed in)
 *  survives as-is — the tick expands it to every installed repo. Empty =
 *  idle. */
export function parseAutofixRepos(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\.git$/, ""))
    .filter((s) => s === "*" || /^[^/\s]+\/[^/\s]+$/.test(s))
}

export function defaultAutofixLedgerPath(): string {
  return process.env.GITHUB_AUTOFIX_PATH ?? "./data/github-autofix.json"
}

export function autofixKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

export function autofixBranch(number: number): string {
  return `nemo/issue-${number}`
}

export class AutofixLedger {
  private handled: Record<string, AutofixLedgerEntry> = {}
  /** Seen-triage ledger: every open issue ever greeted, so the "I can fix
   *  this" comment fires exactly once per issue ever. */
  private seen: Record<string, string> = {}
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? defaultAutofixLedgerPath()
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as {
          handled?: Record<string, AutofixLedgerEntry>
          seen?: Record<string, string>
        }
        if (parsed && typeof parsed === "object") {
          if (parsed.handled && typeof parsed.handled === "object") this.handled = parsed.handled
          if (parsed.seen && typeof parsed.seen === "object") this.seen = parsed.seen
        }
      }
    } catch {
      // Torn write — start empty rather than crash the poller.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ handled: this.handled, seen: this.seen }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* non-POSIX */
    }
    renameSync(tmp, this.file)
  }

  has(repo: string, number: number): boolean {
    return autofixKey(repo, number) in this.handled
  }

  mark(repo: string, number: number, prUrl?: string): void {
    this.handled[autofixKey(repo, number)] = { at: new Date().toISOString(), ...(prUrl ? { prUrl } : {}) }
    this.save()
  }

  greeted(repo: string, number: number): boolean {
    return autofixKey(repo, number) in this.seen
  }

  markGreeted(repo: string, number: number): void {
    this.seen[autofixKey(repo, number)] = new Date().toISOString()
    this.save()
  }
}

export type FetchJson = (path: string, token: string) => Promise<{ status: number; json: unknown }>

/** Open issues (PRs excluded). Label optional: with one, only labeled
 *  issues come back (the fix flow); without, everything open (triage). */
async function listIssues(
  fetchJson: FetchJson,
  token: string,
  repo: string,
  label?: string,
): Promise<AutofixCandidate[]> {
  const [owner, name] = repo.split("/")
  const query =
    `/repos/${owner}/${name}/issues?state=open&per_page=30&sort=created&direction=asc` +
    (label ? `&labels=${encodeURIComponent(label)}` : "")
  const res = await fetchJson(query, token)
  if (res.status !== 200 || !Array.isArray(res.json)) return []
  const out: AutofixCandidate[] = []
  for (const item of res.json) {
    if (!item || typeof item !== "object") continue
    const it = item as { number?: unknown; title?: unknown; pull_request?: unknown }
    if (typeof it.number !== "number" || it.pull_request !== undefined) continue
    out.push({ repo, number: it.number, title: typeof it.title === "string" ? it.title : "" })
  }
  return out
}

/** Open issues carrying the label (PRs excluded — the bot fixes issues). */
export async function listLabeledIssues(
  fetchJson: FetchJson,
  token: string,
  repo: string,
  label: string,
): Promise<AutofixCandidate[]> {
  return listIssues(fetchJson, token, repo, label)
}

/** Every open issue (triage pass). */
export async function listOpenIssues(fetchJson: FetchJson, token: string, repo: string): Promise<AutofixCandidate[]> {
  return listIssues(fetchJson, token, repo, undefined)
}

/** Default triage greeting: static text (no model spend, no prompt-injection
 *  surface — issue bodies never reach an LLM here). */
export function defaultTriageComment(label: string): string {
  return (
    `I can fix this — reply with the error details (what you ran, what happened, logs) and I'll take it from there. ` +
    `Tip: put the \`${label}\` label on this issue to auto-queue a fix branch + PR.`
  )
}

export interface AutofixTickDeps {
  repos: string[]
  label: string
  ledger: AutofixLedger
  /** Installation id for a repo owner (App JWT lookup). */
  installationIdFor: (owner: string) => Promise<number>
  /** Short-lived installation token for an installation id. */
  tokenFor: (installationId: number) => Promise<string>
  fetchJson: FetchJson
  /** Run one agent job; resolves to the thread reply (for PR-url harvest). */
  runJob: (repo: string, number: number, task: string, installationId: number) => Promise<string>
  /** Expand "*" to every installed repo (full names). Omit = "*" matches nothing. */
  listAllRepos?: () => Promise<string[]>
  /** Post a triage comment; resolves true when GitHub accepted it. */
  postComment?: (repo: string, number: number, body: string) => Promise<boolean>
  /** Triage greeting text. Empty string disables the triage pass. */
  triageComment?: string
  /** Max triage comments per tick (spam cap). Default 5. */
  maxTriagePerTick?: number
}

export interface AutofixTickResult {
  checked: number
  ran: Array<{ repo: string; number: number; prUrl?: string }>
  skipped: number
  triaged: string[]
}

/** Max triage greetings per tick — a flood of new issues must not become a
 *  comment flood. */
export const MAX_TRIAGE_PER_TICK = 5

/** One poll: triage pass (greet every unseen open issue, capped) then the
 *  fix flow (oldest labeled unhandled issue, first repo wins — one job per
 *  tick, VPS-sized). */
export async function autofixTick(deps: AutofixTickDeps): Promise<AutofixTickResult> {
  const result: AutofixTickResult = { checked: 0, ran: [], skipped: 0, triaged: [] }
  let repos = deps.repos.filter((r) => r !== "*")
  if (deps.repos.includes("*") && deps.listAllRepos) {
    try {
      const all = await deps.listAllRepos()
      repos = [...repos, ...all.filter((r) => !repos.includes(r))]
    } catch {
      // Expansion failed — fall through with the explicit allowlist.
    }
  }
  const greeting = deps.triageComment === undefined ? defaultTriageComment(deps.label) : deps.triageComment
  const triageCap = Math.min(Math.max(deps.maxTriagePerTick ?? MAX_TRIAGE_PER_TICK, 0), 20)
  for (const repo of repos) {
    const owner = repo.split("/")[0] ?? ""
    let installationId = 0
    try {
      installationId = await deps.installationIdFor(owner)
    } catch {
      continue
    }
    if (!installationId) continue
    let token = ""
    try {
      token = await deps.tokenFor(installationId)
    } catch {
      continue
    }
    if (!token) continue
    // Triage pass: greet unseen open issues (static text, no model).
    if (greeting && deps.postComment && result.triaged.length < triageCap) {
      let open: AutofixCandidate[] = []
      try {
        open = await listOpenIssues(deps.fetchJson, token, repo)
      } catch {
        open = []
      }
      for (const cand of open) {
        if (result.triaged.length >= triageCap) break
        if (deps.ledger.greeted(cand.repo, cand.number)) continue
        let posted = false
        try {
          posted = await deps.postComment(cand.repo, cand.number, greeting)
        } catch {
          posted = false
        }
        // Mark seen only on accept: a failed post retries next tick
        // instead of silently dropping the greeting.
        if (posted) {
          deps.ledger.markGreeted(cand.repo, cand.number)
          result.triaged.push(`${cand.repo}#${cand.number}`)
        }
      }
    }
    let candidates: AutofixCandidate[] = []
    try {
      candidates = await listLabeledIssues(deps.fetchJson, token, repo, deps.label)
    } catch {
      continue
    }
    result.checked += candidates.length
    const next = candidates.find((c) => !deps.ledger.has(c.repo, c.number))
    if (!next) {
      result.skipped += candidates.length
      continue
    }
    const branch = autofixBranch(next.number)
    const task =
      `Fix GitHub issue #${next.number} ("${next.title}") in ${next.repo}. ` +
      `Workflow (in order): 1) read the issue with the github tool (read_issue). ` +
      `2) create branch ${branch} (create_branch). ` +
      `3) apply the smallest correct fix with write_file calls ON THAT BRANCH. ` +
      `4) attach any generated files/logs/artifacts to the same branch with write_file and link them in the PR body. ` +
      `5) open a pull request (create_pr, head ${branch}) titled "Fix #${next.number}: <short>" describing the change + artifact links. ` +
      `Never commit to the default branch. If the issue is unclear or unactionable, say so plainly instead of guessing.`
    let reply = ""
    try {
      reply = await deps.runJob(next.repo, next.number, task, installationId)
    } catch {
      reply = ""
    }
    const prMatch = reply.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/)
    deps.ledger.mark(next.repo, next.number, prMatch ? prMatch[0] : undefined)
    result.ran.push({ repo: next.repo, number: next.number, prUrl: prMatch ? prMatch[0] : undefined })
    return result
  }
  return result
}

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as http from "http"
import { randomBytes, timingSafeEqual } from "crypto"
import { readFileSync } from "node:fs"
import { join as pathJoin } from "node:path"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
import { createTelemetry } from "../../telemetry/src/index.js"
import { listTranscripts } from "../../session-backends/src/transcript.js"
import {
  createAppJwt,
  createInstallationToken,
  describeGithubThread,
  postIssueComment,
  routeGithubEvent,
  selectJobReply,
  splitRepo,
  verifyWebhookSignature,
  type GithubJob,
} from "./github-app.js"
import { activationCheckKey, mintActivationKey } from "../../../apps/runtime/src/license.js"
import { LicenseStore, defaultLicenseStorePaths } from "./license-store.js"
import { GitHubOAuthStore, defaultOAuthPath } from "./github-oauth.js"
import { INSTALL_PS1 } from "./install-ps1.js"
import { INSTALL_SH } from "./install-sh.js"
import { recordJob } from "./github-jobs.js"
import {
  AutofixLedger,
  autofixTick,
  defaultAutofixLedgerPath,
  defaultTriageComment,
  parseAutofixRepos,
} from "./github-autofix.js"
import { resolveCors } from "./cors.js"

/** Read a small JSON body with the shared 1MB cap. Returns null after
 *  responding (413/400) so callers just return. */
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let body = ""
    let bodyBytes = 0
    let done = false
    const fail = (code: number, error: string): void => {
      if (done) return
      done = true
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error }))
      setImmediate(() => req.destroy())
    }
    req.on("data", (c: Buffer | string) => {
      if (done) return
      const chunk = typeof c === "string" ? c : c.toString("utf8")
      bodyBytes += Buffer.byteLength(chunk)
      if (bodyBytes > MAX_BODY_BYTES) {
        fail(413, "body too large (max 1MB)")
        return
      }
      body += chunk
    })
    req.on("end", () => {
      if (done || req.destroyed) return
      try {
        resolve(JSON.parse(body) as Record<string, unknown>)
      } catch {
        fail(400, "invalid JSON")
        resolve(null)
      }
    })
  })
}

/** License generator UI (SKT operators only — POST is bearer-gated by the
 *  global token check above). No external JS/CSS: single file, works
 *  behind Cloudflare with zero build step. */
function adminPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trayambak — license generator</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#111}label{display:block;margin:1rem 0 .25rem;font-weight:600}input,select,button{font-size:1rem;padding:.5rem;width:100%;box-sizing:border-box}button{margin-top:1.25rem;background:#111;color:#fff;border:0;cursor:pointer}#out{margin-top:1.5rem;padding:1rem;background:#f4f4f4;word-break:break-all;display:none;font-family:monospace;font-size:1.2rem}#err{color:#b00;margin-top:1rem}pre{background:#f4f4f4;padding:1rem;overflow:auto;font-size:.8rem}</style>
</head><body>
<h1>Trayambak license generator</h1>
<p>Bearer token is asked once per session and never stored. Minted codes are 16 letters, always <b>1102-…</b>, verified <b>live by this server</b> (registry + 1-machine binding).</p>
<p>Users self-serve a 7-day trial from the TUI (<b>/devmode trial</b> — 1 live trial per machine, born bound, 5/hour per network). Paid keys come from Mint below. Exploitation? Find the key id in <b>Usage</b>, paste it under <b>Revoke</b> — dead in one click, everywhere.</p>
<label>Bearer token (TRAYAMBAK_WEB_TOKEN)<input id="token" type="password" autocomplete="off"></label>
<label>Plan<select id="plan"><option value="pentest">pentest</option><option value="pro">pro</option><option value="enterprise">enterprise</option><option value="basic">basic</option></select></label>
<label>Days valid<input id="days" type="number" value="365" min="1" max="3650"></label>
<label>Customer id (optional)<input id="cid" type="text" placeholder="acme-corp"></label>
<button id="go">Mint license</button>
<div id="err"></div>
<div id="out"></div>
<h2>Register a pre-existing code</h2>
<p>Legacy/offline-era keys must be imported once before their holders can activate them.</p>
<label>Code to import<input id="imp" type="text" placeholder="1102-XXXX-XXXX-XXXX"></label>
<label>Customer id (optional)<input id="impcid" type="text"></label>
<button id="goimp">Import code</button>
<h2>Licenses</h2>
<button id="golist">Refresh list</button>
<pre id="list"></pre>
<h2>Usage (latest 100)</h2>
<button id="gouse">Refresh usage</button>
<pre id="use"></pre>
<h2>Revoke / unbind by id</h2>
<label>License id<input id="lid" type="text"></label>
<button id="gorev">Revoke</button>
<button id="gounb">Unbind machine</button>
<script>
const auth = () => ({ "Content-Type": "application/json", "Authorization": "Bearer " + document.getElementById("token").value });
const show = (el, v) => { const e = document.getElementById(el); e.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); e.style.display = "block"; };
document.getElementById("go").onclick = async () => {
  const err = document.getElementById("err"), out = document.getElementById("out");
  err.textContent = ""; out.style.display = "none";
  try {
    const r = await fetch("/admin/mint", { method: "POST",
      headers: auth(),
      body: JSON.stringify({ plan: document.getElementById("plan").value,
        days: Number(document.getElementById("days").value),
        id: document.getElementById("cid").value || undefined }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    out.textContent = j.key; out.style.display = "block";
  } catch (e) { err.textContent = String((e && e.message) || e); }
};
document.getElementById("goimp").onclick = async () => {
  const err = document.getElementById("err");
  err.textContent = "";
  try {
    const r = await fetch("/admin/import", { method: "POST", headers: auth(),
      body: JSON.stringify({ key: document.getElementById("imp").value,
        customer: document.getElementById("impcid").value || undefined }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    show("out", "imported id " + j.id + " (" + j.plan + ")");
  } catch (e) { err.textContent = String((e && e.message) || e); }
};
document.getElementById("golist").onclick = async () => {
  const r = await fetch("/admin/licenses", { headers: auth() });
  show("list", await r.json());
};
document.getElementById("gouse").onclick = async () => {
  const r = await fetch("/admin/usage?tail=100", { headers: auth() });
  show("use", await r.json());
};
document.getElementById("gorev").onclick = async () => {
  const r = await fetch("/admin/revoke", { method: "POST", headers: auth(),
    body: JSON.stringify({ id: document.getElementById("lid").value }) });
  show("out", await r.json());
};
document.getElementById("gounb").onclick = async () => {
  const r = await fetch("/admin/unbind", { method: "POST", headers: auth(),
    body: JSON.stringify({ id: document.getElementById("lid").value }) });
  show("out", await r.json());
};
</script>
</body></html>`
}

export interface ServerOptions {
  port?: number
  host?: string
  token?: string
  lanOnly?: boolean
  /** License registry file (LICENSE_STORE_PATH). Tests point it at tmp. */
  licenseStorePath?: string
  /** Usage-telemetry JSONL file (LICENSE_USAGE_PATH). */
  licenseUsagePath?: string
  /** GitHub OAuth store file (GITHUB_OAUTH_PATH). Tests point it at tmp. */
  githubOAuthPath?: string
  /** Static image dir for /img/:name (Img/). Tests point it at tmp. */
  imgDir?: string
  /** Docs dir for /docs/:name (docs/). Tests point it at tmp. */
  docsDir?: string /**
   * Extra browser origins allowed to call the API, comma-separated
   * (TRAYAMBAK_WEB_ORIGINS). Same-origin plus loopback origins are always
   * allowed; "*" restores the pre-hardening wildcard; anything else is
   * refused server-side, not merely stripped of CORS headers.
   */
  corsOrigins?: string
}

/** A startServer() handle that also exposes the token actually enforced. */
export interface TrayambakServer extends http.Server {
  /** Caller-provided, env-provided, or generated at startup — never undefined on non-loopback binds. */
  readonly effectiveToken?: string
}

/** Hosts that only the local machine can reach. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"])

/** Max JSON body accepted on POST routes (DoS guard — unbounded concat). */
const MAX_BODY_BYTES = 1_048_576

export const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: { title: "Trayambak Agent API", version: "0.6.3" }, // keep in sync with root package.json
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/v1/models": { get: { summary: "List models" } },
    "/v1/agent": { post: { summary: "Run agent (SSE)" } },
    "/api/sessions": { get: { summary: "List transcripts" } },
    "/admin": { get: { summary: "License generator UI (SKT operators)" } },
    "/admin/mint": { post: { summary: "Mint a 16-letter license (bearer-gated)" } },
    "/admin/import": { post: { summary: "Register a pre-existing code (bearer-gated)" } },
    "/admin/revoke": { post: { summary: "Revoke a license by id (bearer-gated)" } },
    "/admin/unbind": { post: { summary: "Free a license's machine binding (bearer-gated)" } },
    "/admin/licenses": { get: { summary: "List licenses, masked (bearer-gated)" } },
    "/admin/usage": { get: { summary: "Tail pentest usage telemetry (bearer-gated)" } },
    "/admin/jobs": { get: { summary: "Tail GitHub job history (bearer-gated)" } },
    "/license/verify": { post: { summary: "Live license check (public, machine-bound)" } },
    "/license/activate": { post: { summary: "Bind a license to a machine (public)" } },
    "/license/mint-trial": { post: { summary: "Self-service 7-day trial, 1/machine (public, rate-limited)" } },
    "/auth/github/start": { post: { summary: "Begin CLI GitHub login, returns browser URL (public, rate-limited)" } },
    "/auth/github/callback": { get: { summary: "OAuth redirect target (public, browser-facing)" } },
    "/auth/github/status": { get: { summary: "Poll login completion by machine (public)" } },
    "/auth/github/logout": { post: { summary: "Forget a machine's token (public)" } },
    "/github/read": { post: { summary: "Read an issue + comments with the stored user token (public, logged-in)" } },
    "/github/repos": { get: { summary: "List the logged-in user's repos with the stored token (public, logged-in)" } },
    "/github/write": { post: { summary: "Create/update a repo file with the stored user token (public, logged-in)" } },
    "/github/branch": { post: { summary: "Create a repo branch with the stored user token (public, logged-in)" } },
    "/github/pr": { post: { summary: "Open a repo PR with the stored user token (public, logged-in)" } },
    "/github/copy": { post: { summary: "Copy a repo file with the stored user token (public, logged-in)" } },
    "/img/:name": { get: { summary: "Static README images (public, png/jpg only)" } },
    "/docs/:name": { get: { summary: "Docs pages as markdown (public, .md only)" } },
    "/install.ps1": { get: { summary: "Windows one-line installer (public)" } },
    "/install.sh": { get: { summary: "macOS/Linux one-line installer (public)" } },
    "/license/usage": { post: { summary: "Record pentest tool usage (public, licensed)" } },
    "/webhooks/github": { post: { summary: "GitHub App webhook (HMAC verified)" } },
    "/openapi.json": { get: { summary: "OpenAPI spec" } },
  },
} as const

/**
 * A local HTTP server that exposes the trayambak agent over a small JSON/SSE API,
 * mirroring the server packages found in reference agent projects. The agent
 * itself still runs locally against llama.cpp; this just adds a network surface.
 */
export function startServer(options: ServerOptions = {}): TrayambakServer {
  const port = options.port ?? Number(process.env.TRAYAMBAK_SERVER_PORT ?? 8787)
  const host = options.host ?? "127.0.0.1"
  let token = options.token ?? process.env.TRAYAMBAK_WEB_TOKEN
  // Browser origins allowed to call the API (see cors.ts for the decision
  // order). Read once at startup so the policy cannot change mid-process.
  const corsOrigins = options.corsOrigins ?? process.env.TRAYAMBAK_WEB_ORIGINS ?? ""
  // Fail closed: a non-loopback bind must never serve the agent API without
  // auth. If the operator didn't provide a token, generate a strong one for
  // this process and print it (same pattern as webhooks below, which refuse
  // to run without GITHUB_WEBHOOK_SECRET). Loopback-only binds keep the
  // documented local-dev behaviour: no token means no auth on 127.0.0.1.
  let generatedToken = false
  if (!token && !LOOPBACK_HOSTS.has(host)) {
    token = randomBytes(32).toString("hex")
    generatedToken = true
  }
  const config = loadConfig()
  const telemetry = createTelemetry(/*enabled*/ false)
  // License registry: minted/imported key ids live here. Forged codes
  // (valid checksum, unknown id) die in checkLicense — the shipped check
  // key alone mints nothing the server honors.
  const licenseDefaults = defaultLicenseStorePaths()
  const licenses = new LicenseStore({
    file: options.licenseStorePath ?? licenseDefaults.file,
    usageFile: options.licenseUsagePath ?? licenseDefaults.usageFile,
  })

  /** Public surface: no bearer token required.
   *  - /license/*: the CLI holds no token (machine-bound licenses instead).
   *  - /webhooks/github: GitHub holds no token either — HMAC-SHA256
   *    (X-Hub-Signature-256) IS its auth, verified per-request. Never gate
   *    this behind bearer: every delivery would 401 "unauthorized" before
   *    the signature is even looked at (observed live).
   *  Exact pathnames only (never a prefix — no /license/../admin smuggling).
   *  Everything else stays bearer-gated. */
  const PUBLIC_LICENSE_PATHS = new Set([
    "/license/verify",
    "/license/activate",
    "/license/usage",
    "/license/mint-trial",
    "/webhooks/github",
    "/auth/github/start",
    "/auth/github/callback",
    "/auth/github/status",
    "/auth/github/logout",
    "/github/read",
    "/github/repos",
    "/github/write",
    "/github/branch",
    "/github/pr",
    "/github/copy",
    "/install.ps1",
    "/install.sh",
  ])
  // README images live next to the code (Img/); npmjs.com renders
  // tarball-relative image links unreliably, so absolute URLs point here.
  const imgDir = options.imgDir ?? process.env.TRAYAMBAK_IMG_DIR ?? "./Img"
  // Same story for the README's Documentation table: docs/*.md links would
  // 404 on npm (docs/ isn't even in the tarball), so /docs/:name serves
  // them as markdown text. Whitelist-only, like /img/.
  const docsDir = options.docsDir ?? process.env.TRAYAMBAK_DOCS_DIR ?? "./docs"

  /** Self-service trial abuse guard: max 5 trial mints per client IP per
   *  hour (in-memory, per process — adequate for trial issuance rates).
   *  The registry adds the harder rule: 1 live trial per machine, ever
   *  until it expires. */
  const trialHitsByIp = new Map<string, number[]>()
  const TRIAL_MINTS_PER_HOUR = 5
  /** Same shape for OAuth login starts (10/hour/IP): the authorize URL is
   *  cheap, but bots must not be able to flood state storage. */
  const oauthHitsByIp = new Map<string, number[]>()
  const OAUTH_STARTS_PER_HOUR = 10
  const githubOAuth = new GitHubOAuthStore(options.githubOAuthPath ?? defaultOAuthPath())

  // Automatic issue fixing (label-gated, PR-only — see github-autofix.ts).
  // Empty allowlist = idle. "*" watches every installed repo. First tick
  // delayed 2 min (no boot-time model spend), then every interval. Timers
  // unref'd so tests exit cleanly.
  const autofixRepos = parseAutofixRepos(process.env.GITHUB_AUTOFIX_REPOS)
  const autofixLabel = (process.env.GITHUB_AUTOFIX_LABEL ?? "trayambak").trim() || "trayambak"
  const autofixMinutes = Math.min(Math.max(Number(process.env.GITHUB_AUTOFIX_INTERVAL_MIN ?? 30) || 30, 5), 1440)
  // Triage greeting for every new issue (static text, no model spend).
  // Empty string disables the triage pass (fix flow unaffected).
  const autofixTriage =
    process.env.GITHUB_AUTOFIX_TRIAGE_COMMENT === undefined
      ? defaultTriageComment(autofixLabel)
      : (process.env.GITHUB_AUTOFIX_TRIAGE_COMMENT ?? "")
  if (autofixRepos.length > 0) {
    const autofixLedger = new AutofixLedger(defaultAutofixLedgerPath())
    const runAutofixTick = (): void => {
      void (async () => {
        try {
          const result = await autofixTick({
            repos: autofixRepos,
            label: autofixLabel,
            ledger: autofixLedger,
            installationIdFor: installationIdForOwner,
            tokenFor: installationTokenFor,
            fetchJson: async (path, token) => {
              const r = await githubApi(path, token)
              return { status: r.status, json: r.json }
            },
            listAllRepos: allInstalledRepos,
            postComment: async (repo, number, body) => {
              const owner = repo.split("/")[0] ?? ""
              const installationId = await installationIdForOwner(owner).catch(() => 0)
              if (!installationId) return false
              const token = await installationTokenFor(installationId).catch(() => "")
              if (!token) return false
              return postGithubComment(owner, repo.split("/")[1] ?? "", number, body, token)
            },
            triageComment: autofixTriage,
            runJob: (repo, number, task, installationId) =>
              enqueueGithubJob(
                { repoFullName: repo, issueNumber: number, task, isPullRequest: false },
                { installation: { id: installationId } },
              ),
          })
          if (result.checked > 0 || result.ran.length > 0 || result.triaged.length > 0) {
            process.stdout.write(
              `[github-autofix] tick: checked ${result.checked}, ran ${result.ran.length}, triaged ${result.triaged.length}\n`,
            )
          }
        } catch (err) {
          process.stderr.write(`[github-autofix] tick failed: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      })()
    }
    const autofixTimer = setInterval(runAutofixTick, autofixMinutes * 60_000)
    if (typeof autofixTimer.unref === "function") autofixTimer.unref()
    const firstTick = setTimeout(runAutofixTick, 120_000)
    if (typeof firstTick.unref === "function") firstTick.unref()
    process.stdout.write(
      `[github-autofix] watching ${autofixRepos.join(",")} label=${autofixLabel} every ${autofixMinutes}m\n`,
    )
  } else {
    process.stdout.write("[github-autofix] idle (GITHUB_AUTOFIX_REPOS unset)\n")
  }

  const server = http.createServer(async (req, res) => {
    // Origin policy first: a refused browser origin never reaches a route,
    // including the unauthenticated /license and /auth/github ones (a CORS
    // header alone would not stop a simple cross-origin POST).
    const cors = resolveCors(req.headers.origin, req.headers.host, corsOrigins)
    for (const [header, value] of Object.entries(cors.headers)) {
      res.setHeader(header, value)
    }
    if (req.method === "OPTIONS") {
      res.writeHead(cors.allowed ? 204 : 403)
      res.end()
      return
    }
    if (!cors.allowed) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "origin not allowed" }))
      return
    }
    const pathname = (req.url ?? "/").split("?")[0]
    // Static README images (public). Exact-path gate below can't express
    // /img/:name, so this prefix branch runs first — read-only, strict
    // filename whitelist, no traversal possible by construction.
    if (req.method === "GET" && pathname.startsWith("/img/")) {
      serveReadmeImage(req, res, imgDir, pathname)
      return
    }
    // Same for the README's Documentation table (/docs/:name, markdown).
    if (req.method === "GET" && pathname.startsWith("/docs/")) {
      serveDocsFile(req, res, docsDir, pathname)
      return
    }
    if (token && req.url !== "/health" && !PUBLIC_LICENSE_PATHS.has(pathname)) {
      // Constant-time compare: a plain !== leaks prefix length via timing.
      const presented = Buffer.from(req.headers.authorization ?? "")
      const expected = Buffer.from(`Bearer ${token}`)
      const authorized =
        presented.length === expected.length && presented.length > 0 && timingSafeEqual(presented, expected)
      if (!authorized) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", model: config.model }))
      return
    }

    if (req.method === "GET" && req.url === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(OPENAPI_SPEC))
      return
    }

    if (req.method === "GET" && req.url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" })
      try {
        res.end(JSON.stringify({ sessions: listTranscripts() }))
      } catch {
        res.end(JSON.stringify({ sessions: [] }))
      }
      return
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: config.model }] }))
      return
    }

    if (req.method === "GET" && req.url === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(adminPage())
      return
    }

    if (req.method === "POST" && req.url === "/admin/mint") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const plan = typeof parsed.plan === "string" ? parsed.plan : ""
      const days = typeof parsed.days === "number" ? parsed.days : Number.NaN
      if (plan !== "basic" && plan !== "pentest" && plan !== "pro" && plan !== "enterprise") {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "plan must be basic|pentest|pro|enterprise" }))
        return
      }
      if (!Number.isFinite(days) || days < 1 || days > 3650) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "days must be 1..3650" }))
        return
      }
      try {
        // `days` is a human duration from today; the wire format counts
        // from the key epoch, so convert here (a raw epoch-days value
        // from the form would mint already-expired keys — caught by test).
        const todayDays = Math.floor(Date.now() / 86400000)
        const { activationEpochDays } = await import("../../../apps/runtime/src/license.js")
        const key = mintActivationKey(
          { plan, expDays: todayDays - activationEpochDays() + Math.floor(days) },
          activationCheckKey(),
        )
        // Registry membership is the actual unforgeability: the minted id
        // is recorded NOW, so only this code verifies later.
        const customer = typeof parsed.id === "string" ? parsed.id : undefined
        const rec = licenses.register(key, customer)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ key, id: rec.id }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `mint failed: ${err instanceof Error ? err.message : String(err)}` }))
      }
      return
    }

    // ---- Server-side licensing (public: the CLI holds no bearer token) ----
    // verify: live check (registry + expiry + revocation + machine binding).
    if (req.method === "GET" && pathname === "/install.ps1") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(INSTALL_PS1)
      return
    }

    if (req.method === "GET" && pathname === "/install.sh") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(INSTALL_SH)
      return
    }

    if (req.method === "POST" && pathname === "/license/verify") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      if (!machine) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: false, reason: "missing machineId" }))
        return
      }
      const c = licenses.check(typeof parsed.key === "string" ? parsed.key : "", machine)
      if (c.valid === true) licenses.touch(c.record?.id ?? "")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ valid: c.valid, plan: c.plan, exp: c.exp, reason: c.reason }))
      return
    }

    // activate: first-use machine binding (1-machine limit, idempotent).
    if (req.method === "POST" && pathname === "/license/activate") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      if (!machine) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "missing machineId" }))
        return
      }
      const a = licenses.activate(typeof parsed.key === "string" ? parsed.key : "", machine)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: a.ok, plan: a.plan, exp: a.exp, reason: a.reason }))
      return
    }

    // usage: pentest audit trail. Pentest-plan enforced server-side too —
    // a basic key never records (and the CLI gate never lets it run).
    if (req.method === "POST" && pathname === "/license/usage") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tool = typeof parsed.tool === "string" ? parsed.tool.slice(0, 120) : ""
      if (!machine || !tool) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "missing machineId/tool" }))
        return
      }
      const c = licenses.checkPentestOnly(typeof parsed.key === "string" ? parsed.key : "", machine)
      if (c.valid !== true) {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: c.reason ?? "license invalid" }))
        return
      }
      licenses.touch(c.record?.id ?? "")
      licenses.appendUsage({
        keyId: c.record?.id ?? "",
        machineId: machine,
        tool,
        target: typeof parsed.target === "string" ? parsed.target.slice(0, 300) : "",
        ok: parsed.ok !== false,
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // mint-trial: SELF-SERVICE trial issuance (public). Anyone can mint ONE
    // short pentest trial per machine, born bound to that machine (so the
    // minter cannot share it — it never works anywhere else). Operator
    // keys still come only from /admin/mint; exploitation dies by
    // /admin/revoke on the key id (see /admin/usage for the audit trail).
    if (req.method === "POST" && pathname === "/license/mint-trial") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      if (!machine) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "missing machineId" }))
        return
      }
      const ip = clientIp(req)
      const now = Date.now()
      const hits = (trialHitsByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000)
      if (hits.length >= TRIAL_MINTS_PER_HOUR) {
        res.writeHead(429, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "too many trial requests from this network — try again later" }))
        return
      }
      hits.push(now)
      trialHitsByIp.set(ip, hits)
      if (licenses.activeTrialForMachine(machine)) {
        res.writeHead(409, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "this machine already has a live trial — ask SKT for a full key" }))
        return
      }
      try {
        const rawDays = Number(process.env.LICENSE_TRIAL_DAYS ?? 7)
        const days = Math.min(Math.max(Math.floor(Number.isFinite(rawDays) ? rawDays : 7), 1), 30)
        const todayDays = Math.floor(Date.now() / 86400000)
        const { activationEpochDays } = await import("../../../apps/runtime/src/license.js")
        const key = mintActivationKey(
          { plan: "pentest", expDays: todayDays - activationEpochDays() + days },
          activationCheckKey(),
        )
        const rec = licenses.register(key, "trial", { trial: true })
        // Born bound: the trial works on THIS machine from birth and
        // nowhere else. No separate activation step needed (activate stays
        // idempotent for it anyway).
        const bound = licenses.activate(key, machine)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: bound.ok, key, id: rec.id, exp: rec.exp, days }))
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            ok: false,
            reason: `trial mint failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
        )
      }
      return
    }

    // ---- GitHub user authorization (public: the CLI holds no bearer) ----
    // CLI → POST /auth/github/start → {url} → user approves in browser →
    // GitHub → GET /auth/github/callback → token filed under machine id →
    // CLI polls /auth/github/status → then POST /github/read rides it.
    if (req.method === "POST" && pathname === "/auth/github/start") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      if (!machine) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "missing machineId" }))
        return
      }
      const clientId = (process.env.GITHUB_CLIENT_ID ?? "").trim()
      if (!clientId) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "GitHub login not configured on this server" }))
        return
      }
      const ip = clientIp(req)
      const now = Date.now()
      const hits = (oauthHitsByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000)
      if (hits.length >= OAUTH_STARTS_PER_HOUR) {
        res.writeHead(429, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, reason: "too many login requests from this network — try again later" }))
        return
      }
      hits.push(now)
      oauthHitsByIp.set(ip, hits)
      const st = githubOAuth.beginLogin(machine)
      // `repo` scope: without it the stored token reads but can never
      // write — /github/write|branch|pr|copy would 403 on every call and
      // the agent would keep asking for GITHUB_TOKEN. Scope is granted at
      // Approve-time in the browser; existing logins re-login once.
      const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=repo&state=${st.state}`
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, url }))
      return
    }

    if (req.method === "GET" && pathname === "/auth/github/callback") {
      // Browser-facing: always answer HTML, never JSON — the user just
      // clicked Approve and wants words, not a payload.
      const page = (title: string, body: string, ok: boolean): void => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
            `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem}</style></head>` +
            `<body><h1>${title}</h1><p>${body}</p></body></html>`,
        )
      }
      const query = new URL(req.url ?? "/", "http://localhost").searchParams
      const code = query.get("code") ?? ""
      const state = query.get("state") ?? ""
      const machine = githubOAuth.consumeState(state)
      if (!code || !machine) {
        page(
          "Authorization failed",
          "This link is expired or already used (10-minute, single-use). Run /github login in the CLI again for a fresh one.",
          /*ok*/ false,
        )
        return
      }
      const clientId = (process.env.GITHUB_CLIENT_ID ?? "").trim()
      const clientSecret = (process.env.GITHUB_CLIENT_SECRET ?? "").trim()
      if (!clientId || !clientSecret) {
        page("Server misconfigured", "GitHub login is not configured on this server.", /*ok*/ false)
        return
      }
      try {
        const ex = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "trayambak" },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
          signal: AbortSignal.timeout(20_000),
        })
        const ej = (await ex.json()) as { access_token?: unknown; error_description?: unknown }
        if (!ex.ok || typeof ej.access_token !== "string" || !ej.access_token) {
          throw new Error(typeof ej.error_description === "string" ? ej.error_description : `HTTP ${ex.status}`)
        }
        const me = await githubApi("/user", ej.access_token)
        const login =
          me.json && typeof me.json === "object" && typeof (me.json as { login?: unknown }).login === "string"
            ? ((me.json as { login: string }).login as string)
            : "github-user"
        githubOAuth.storeToken(machine, ej.access_token, login)
        page(
          "Authorized",
          `Logged in as <b>${login}</b>. Return to the CLI — it picks this up automatically.`,
          /*ok*/ true,
        )
      } catch (err) {
        page(
          "Authorization failed",
          `Could not finish login (${err instanceof Error ? err.message : String(err)}). Run /github login again.`,
          /*ok*/ false,
        )
      }
      return
    }

    if (req.method === "GET" && pathname === "/auth/github/status") {
      const machine = licenseMachineId(new URL(req.url ?? "/", "http://localhost").searchParams.get("machineId"))
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(tok ? { authorized: true, login: tok.login } : { authorized: false }))
      return
    }

    if (req.method === "POST" && pathname === "/auth/github/logout") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: machine ? githubOAuth.logout(machine) : false }))
      return
    }

    if (req.method === "POST" && pathname === "/github/read") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      let owner = ""
      let repo = ""
      try {
        ;({ owner, repo } = splitRepo(typeof parsed.repo === "string" ? parsed.repo : ""))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "repo must be owner/name" }))
        return
      }
      const number = Math.floor(Number(parsed.number))
      if (!Number.isFinite(number) || number < 1) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "number must be a positive issue/PR number" }))
        return
      }
      const withComments = parsed.withComments !== false
      const [issue, comments] = await Promise.all([
        githubApi(`/repos/${owner}/${repo}/issues/${number}`, tok.token),
        withComments
          ? githubApi(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=20`, tok.token)
          : Promise.resolve({ status: 200, json: [] as unknown }),
      ])
      if (issue.status === 0) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub unreachable from the license server" }))
        return
      }
      if (issue.status !== 200 || !issue.json || typeof issue.json !== "object") {
        const msg =
          issue.json &&
          typeof issue.json === "object" &&
          typeof (issue.json as { message?: unknown }).message === "string"
            ? ((issue.json as { message: string }).message as string)
            : `HTTP ${issue.status}`
        res.writeHead(issue.status === 404 ? 404 : 502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${msg}` }))
        return
      }
      const j = issue.json as {
        number?: unknown
        title?: unknown
        state?: unknown
        user?: { login?: unknown }
        body?: unknown
        comments?: unknown
        html_url?: unknown
        pull_request?: unknown
      }
      const list = Array.isArray(comments.json) ? comments.json : []
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          issue: {
            number: typeof j.number === "number" ? j.number : number,
            title: typeof j.title === "string" ? j.title : "",
            state: typeof j.state === "string" ? j.state : "",
            author: j.user && typeof j.user === "object" && typeof j.user.login === "string" ? j.user.login : "",
            url: typeof j.html_url === "string" ? j.html_url : "",
            body: typeof j.body === "string" ? j.body.slice(0, 8000) : "",
            commentsCount: typeof j.comments === "number" ? j.comments : list.length,
            isPullRequest: j.pull_request !== undefined,
          },
          comments: list
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
            .slice(-20)
            .map((c) => ({
              author:
                c.user && typeof c.user === "object" && typeof (c.user as { login?: unknown }).login === "string"
                  ? ((c.user as { login: string }).login as string)
                  : "",
              body: typeof c.body === "string" ? c.body.slice(0, 2000) : "",
              createdAt: typeof c.created_at === "string" ? c.created_at : "",
            })),
        }),
      )
      return
    }

    // ---- VPS-routed GitHub writes (public, machine-bound, logged-in) ----
    // The CLI never holds the user OAuth token (github-oauth.ts: it is
    // NEVER returned), so agent writes ride the SAME stored token that
    // /github/read uses — a direct VPS relation, no GITHUB_TOKEN paste.
    // MachineId-bound like reads; the token never leaves this process.
    // Writes are the sharp edge (a leaked machineId writes AS the user),
    // so every route validates repo/path/branch shapes + the 100KB content
    // cap before touching api.github.com, and answers 401 with the login
    // hint when no token is filed for the machine.
    if (req.method === "GET" && pathname === "/github/repos") {
      const machine = licenseMachineId(new URL(req.url ?? "/", "http://localhost").searchParams.get("machineId"))
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      const list = await githubApi(`/user/repos?per_page=100&sort=updated`, tok.token)
      if (list.status === 0) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub unreachable from the license server" }))
        return
      }
      if (list.status !== 200 || !Array.isArray(list.json)) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(list.json, list.status)}` }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          login: tok.login,
          repos: (list.json as Array<Record<string, unknown>>)
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
            .map((r) => ({
              fullName: typeof r.full_name === "string" ? r.full_name : "",
              private: r.private === true,
              defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main",
              updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
            }))
            .filter((r) => r.fullName.length > 0),
        }),
      )
      return
    }

    if (req.method === "POST" && pathname === "/github/write") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      let owner = ""
      let repo = ""
      try {
        ;({ owner, repo } = splitRepo(typeof parsed.repo === "string" ? parsed.repo : ""))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "repo must be owner/name" }))
        return
      }
      const filePath = typeof parsed.path === "string" ? parsed.path.trim().replace(/^\/+/, "") : ""
      if (!filePath || filePath.split("/").includes("..")) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "path must be a repo-relative file path (no ..)" }))
        return
      }
      const content = typeof parsed.content === "string" ? parsed.content : ""
      if (Buffer.byteLength(content, "utf8") > 100_000) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "content over 100KB — split it or open a PR" }))
        return
      }
      const message =
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim().slice(0, 200)
          : `trayambak: update ${filePath}`
      const branch = typeof parsed.branch === "string" && parsed.branch.trim() ? parsed.branch.trim() : undefined
      const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : ""
      const existing = await githubApi(
        `/repos/${owner}/${repo}/contents/${encodeContentPath(filePath)}${refQuery}`,
        tok.token,
      )
      let sha: string | undefined
      if (existing.status >= 200 && existing.status < 300) {
        const ej = existing.json as { sha?: unknown; type?: unknown } | null
        if (!ej || typeof ej !== "object" || ej.type === undefined || ej.type === "file") {
          sha =
            typeof (ej as { sha?: unknown } | null)?.sha === "string"
              ? ((ej as { sha: string }).sha as string)
              : undefined
        } else {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: `${filePath} exists but is not a file — refusing to overwrite` }))
          return
        }
      } else if (existing.status !== 404) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(existing.json, existing.status)}` }))
        return
      }
      const put = await githubApi(
        `/repos/${owner}/${repo}/contents/${encodeContentPath(filePath)}`,
        tok.token,
        20_000,
        {
          method: "PUT",
          body: {
            message,
            content: Buffer.from(content, "utf8").toString("base64"),
            ...(sha ? { sha } : {}),
            ...(branch ? { branch } : {}),
          },
        },
      )
      if (put.status < 200 || put.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(put.json, put.status)}` }))
        return
      }
      const pj = put.json as { commit?: { sha?: unknown } } | null
      const commitSha =
        pj && typeof pj === "object" && pj.commit && typeof pj.commit.sha === "string" ? pj.commit.sha : ""
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, commit: commitSha.slice(0, 7) || null }))
      return
    }

    if (req.method === "POST" && pathname === "/github/branch") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      let owner = ""
      let repo = ""
      try {
        ;({ owner, repo } = splitRepo(typeof parsed.repo === "string" ? parsed.repo : ""))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "repo must be owner/name" }))
        return
      }
      const branch = typeof parsed.branch === "string" ? parsed.branch.trim() : ""
      if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,120}$/.test(branch)) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `invalid branch name "${branch}"` }))
        return
      }
      const meta = await githubApi(`/repos/${owner}/${repo}`, tok.token)
      if (meta.status < 200 || meta.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(meta.json, meta.status)}` }))
        return
      }
      const mj = meta.json as { default_branch?: unknown } | null
      const baseBranch =
        typeof parsed.base === "string" && parsed.base.trim()
          ? parsed.base.trim()
          : mj && typeof mj === "object" && typeof mj.default_branch === "string"
            ? mj.default_branch
            : "main"
      const ref = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, tok.token)
      if (ref.status < 200 || ref.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(ref.json, ref.status)}` }))
        return
      }
      const rj = ref.json as { object?: { sha?: unknown } } | null
      const baseSha =
        rj && typeof rj === "object" && rj.object && typeof rj.object.sha === "string" ? rj.object.sha : ""
      if (!baseSha) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `could not find sha for base ${baseBranch}` }))
        return
      }
      const created = await githubApi(`/repos/${owner}/${repo}/git/refs`, tok.token, 20_000, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: baseSha },
      })
      if (created.status === 422) {
        res.writeHead(409, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `branch ${branch} already exists — write onto it directly` }))
        return
      }
      if (created.status < 200 || created.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(created.json, created.status)}` }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, branch, base: baseBranch }))
      return
    }

    if (req.method === "POST" && pathname === "/github/pr") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      let owner = ""
      let repo = ""
      try {
        ;({ owner, repo } = splitRepo(typeof parsed.repo === "string" ? parsed.repo : ""))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "repo must be owner/name" }))
        return
      }
      const head = typeof parsed.head === "string" ? parsed.head.trim() : ""
      const title = typeof parsed.title === "string" ? parsed.title.trim() : ""
      if (!head || !title) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "head branch and title are required" }))
        return
      }
      const created = await githubApi(`/repos/${owner}/${repo}/pulls`, tok.token, 20_000, {
        method: "POST",
        body: {
          title: title.slice(0, 200),
          head,
          ...(typeof parsed.base === "string" && parsed.base.trim() ? { base: parsed.base.trim() } : {}),
          body: typeof parsed.body === "string" ? parsed.body.slice(0, 8000) : "",
        },
      })
      if (created.status < 200 || created.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(created.json, created.status)}` }))
        return
      }
      const cj = created.json as { html_url?: unknown; number?: unknown } | null
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          number: cj && typeof cj === "object" && typeof cj.number === "number" ? cj.number : null,
          url: cj && typeof cj === "object" && typeof cj.html_url === "string" ? cj.html_url : "",
        }),
      )
      return
    }

    if (req.method === "POST" && pathname === "/github/copy") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const machine = licenseMachineId(parsed.machineId)
      const tok = machine ? githubOAuth.tokenFor(machine) : undefined
      if (!tok) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "GitHub login required — run /github login first" }))
        return
      }
      let owner = ""
      let repo = ""
      try {
        ;({ owner, repo } = splitRepo(typeof parsed.repo === "string" ? parsed.repo : ""))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "repo must be owner/name" }))
        return
      }
      const sourcePath = typeof parsed.sourcePath === "string" ? parsed.sourcePath.trim().replace(/^\/+/, "") : ""
      const destPath = typeof parsed.destPath === "string" ? parsed.destPath.trim().replace(/^\/+/, "") : ""
      if (!sourcePath || !destPath || sourcePath.split("/").includes("..") || destPath.split("/").includes("..")) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "sourcePath and destPath must be repo-relative file paths (no ..)" }))
        return
      }
      const src = await githubApi(`/repos/${owner}/${repo}/contents/${encodeContentPath(sourcePath)}`, tok.token)
      if (src.status < 200 || src.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(src.json, src.status)}` }))
        return
      }
      const sj = src.json as { content?: unknown } | null
      if (!sj || typeof sj !== "object" || typeof sj.content !== "string" || !sj.content) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `${sourcePath} has no retrievable content` }))
        return
      }
      const b64 = Buffer.from(Buffer.from(sj.content, "base64").toString("utf8"), "utf8").toString("base64")
      const existing = await githubApi(`/repos/${owner}/${repo}/contents/${encodeContentPath(destPath)}`, tok.token)
      let sha: string | undefined
      if (existing.status >= 200 && existing.status < 300) {
        const ej = existing.json as { sha?: unknown } | null
        sha = ej && typeof ej === "object" && typeof ej.sha === "string" ? ej.sha : undefined
      }
      const put = await githubApi(
        `/repos/${owner}/${repo}/contents/${encodeContentPath(destPath)}`,
        tok.token,
        20_000,
        {
          method: "PUT",
          body: {
            message: `trayambak: copy ${sourcePath} -> ${destPath}`,
            content: b64,
            ...(sha ? { sha } : {}),
          },
        },
      )
      if (put.status < 200 || put.status >= 300) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `GitHub: ${githubErrorMessage(put.json, put.status)}` }))
        return
      }
      const pj = put.json as { commit?: { sha?: unknown } } | null
      const commitSha =
        pj && typeof pj === "object" && pj.commit && typeof pj.commit.sha === "string" ? pj.commit.sha : ""
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, commit: commitSha.slice(0, 7) || null }))
      return
    }

    // ---- License admin (bearer-gated like /admin/mint) ----
    // import: register a pre-existing (legacy/offline-era) code so its
    // holder can activate it. Checksum must verify; id joins the registry.
    if (req.method === "POST" && req.url === "/admin/import") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      try {
        const rec = licenses.register(
          typeof parsed.key === "string" ? parsed.key : "",
          typeof parsed.customer === "string" ? parsed.customer : undefined,
        )
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: rec.id, plan: rec.plan }))
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
      return
    }

    if (req.method === "POST" && req.url === "/admin/revoke") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const id = typeof parsed.id === "string" ? parsed.id : ""
      if (!id || !licenses.revoke(id)) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unknown license id" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === "POST" && req.url === "/admin/unbind") {
      const parsed = await readJsonBody(req, res)
      if (!parsed) return
      const id = typeof parsed.id === "string" ? parsed.id : ""
      if (!id || !licenses.unbind(id)) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unknown license id" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === "GET" && pathname === "/admin/licenses") {
      const rows = licenses.list().map((r) => ({
        id: r.id,
        key: `${r.key.slice(0, 4)}-…-${r.key.slice(-4)}`,
        plan: r.plan,
        exp: r.exp,
        customer: r.customer,
        trial: r.trial === true,
        revoked: r.revoked,
        bound: Boolean(r.boundMachineId),
        machine: r.boundMachineId ? `${r.boundMachineId.slice(0, 8)}…` : undefined,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
      }))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ licenses: rows }))
      return
    }

    if (req.method === "GET" && pathname === "/admin/usage") {
      const tail = Number((req.url ?? "").split("tail=")[1] ?? 100)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ usage: licenses.readUsageTail(Number.isFinite(tail) ? tail : 100) }))
      return
    }

    if (req.method === "GET" && pathname === "/admin/jobs") {
      const tail = Number((req.url ?? "").split("tail=")[1] ?? 100)
      const { readJobTail } = await import("./github-jobs.js")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ jobs: readJobTail(Number.isFinite(tail) ? tail : 100) }))
      return
    }

    if (req.method === "POST" && req.url === "/webhooks/github") {
      // Fail closed: no secret configured means no webhooks accepted.
      const secret = process.env.GITHUB_WEBHOOK_SECRET ?? ""
      if (!secret) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "webhooks disabled (GITHUB_WEBHOOK_SECRET unset)" }))
        return
      }
      const chunks: Buffer[] = []
      let rawBytes = 0
      let oversize = false
      req.on("data", (c: Buffer) => {
        if (oversize) return
        const buf = typeof c === "string" ? Buffer.from(c, "utf8") : c
        rawBytes += buf.length
        if (rawBytes > MAX_BODY_BYTES) {
          oversize = true
          res.writeHead(413, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "body too large (max 1MB)" }))
          setImmediate(() => req.destroy())
          return
        }
        chunks.push(buf)
      })
      req.on("end", () => {
        if (oversize || req.destroyed) return
        const raw = Buffer.concat(chunks)
        const signature = req.headers["x-hub-signature-256"]
        if (!verifyWebhookSignature(secret, raw, Array.isArray(signature) ? signature[0] : signature)) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "bad signature" }))
          return
        }
        let payload: unknown = null
        try {
          payload = JSON.parse(raw.toString("utf8"))
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "invalid JSON" }))
          return
        }
        const event = req.headers["x-github-event"]
        const outcome = routeGithubEvent(Array.isArray(event) ? (event[0] ?? "") : (event ?? ""), payload)
        if (outcome.kind !== "job") {
          // Always 2xx for non-jobs so GitHub never retry-storms us.
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, ...(outcome.kind === "ignored" ? { ignored: outcome.reason } : {}) }))
          return
        }
        res.writeHead(202, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, accepted: true }))
        // Serialized: one job at a time. The 1GB VPS cannot survive
        // concurrent agent runs, and runGithubJob temporarily lends its
        // installation token via process.env.GITHUB_TOKEN — overlapping runs
        // would swap each other's credentials mid-flight.
        void enqueueGithubJob(outcome.job, payload)
      })
      return
    }

    if (req.method === "POST" && req.url === "/v1/agent") {
      let body = ""
      let bodyBytes = 0
      let rejected = false
      // Abort the agent run when the client goes away mid-stream, so a
      // dropped SSE connection cannot leave a model turn burning tokens
      // forever on the VPS.
      const controller = new AbortController()
      req.on("close", () => controller.abort())
      req.on("data", (c) => {
        if (rejected) return
        const chunk = typeof c === "string" ? c : c.toString("utf8")
        bodyBytes += Buffer.byteLength(chunk)
        if (bodyBytes > MAX_BODY_BYTES) {
          rejected = true
          res.writeHead(413, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "body too large (max 1MB)" }))
          // Destroy only after the 413 flushes — killing the socket first
          // turns into ECONNRESET on the client instead of a clean 413.
          setImmediate(() => req.destroy())
          return
        }
        body += chunk
      })
      req.on("end", () => {
        if (rejected || req.destroyed) return
        const parsed = safeJson(body)
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt : undefined
        const sessionFile = typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined
        if (!prompt || typeof prompt !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "missing 'prompt'" }))
          return
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        const agent = new Agent({ config, sessionFile })
        const safeWrite = (chunk: string): void => {
          try {
            if (!req.destroyed && !res.writableEnded) res.write(chunk)
          } catch {
            controller.abort()
          }
        }
        agent
          .run(
            prompt,
            (event) => {
              telemetry.capture(event)
              safeWrite(`data: ${JSON.stringify(event)}\n\n`)
            },
            controller.signal,
          )
          .then(() => {
            safeWrite("data: [DONE]\n\n")
            try {
              if (!req.destroyed && !res.writableEnded) res.end()
            } catch {
              /* client already gone */
            }
          })
          .catch((err) => {
            safeWrite(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
            try {
              if (!req.destroyed && !res.writableEnded) res.end()
            } catch {
              /* client already gone */
            }
          })
      })
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  server.listen(port, host, () => {
    process.stdout.write(`trayambak server listening on http://${host}:${port}\n`)
    if (generatedToken && token) {
      // A token was required but not supplied; the operator needs this value
      // to authenticate. Printed once at startup, never logged elsewhere.
      process.stdout.write(`generated bearer token (set TRAYAMBAK_WEB_TOKEN to avoid this): ${token}\n`)
    }
  })
  Object.defineProperty(server, "effectiveToken", { value: token ?? "", enumerable: false })
  return server as TrayambakServer
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Serial job queue — see the webhook accept path. */
let githubJobQueue: Promise<void> = Promise.resolve()

/** Serial job queue — GitHub agent work runs one at a time (1GB VPS +
 *  process.env token lending must never interleave). Resolves to the thread
 *  reply ("" when the run itself errored — already logged). */
function enqueueGithubJob(job: GithubJob, payload: unknown): Promise<string> {
  const next = githubJobQueue
    .then(() => runGithubJob(job, payload))
    .catch((err) => {
      process.stderr.write(`[github-app] job failed: ${err instanceof Error ? err.message : String(err)}\n`)
      return ""
    })
  githubJobQueue = next.then(() => undefined)
  return next
}

/** Post an issue comment with a user/installation token. True on 201. */
async function postGithubComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "trayambak",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: body.slice(0, 4000) }),
      signal: AbortSignal.timeout(20_000),
    })
    return res.status === 201
  } catch {
    return false
  }
}

/** Every installed repo (full names) for the "*" watchlist. */
async function allInstalledRepos(): Promise<string[]> {
  const jwt = githubAppJwt()
  if (!jwt) return []
  try {
    const res = await fetch("https://api.github.com/app/installations", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "trayambak",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    })
    const installations = (await res.json()) as Array<{ id?: unknown }>
    if (!res.ok || !Array.isArray(installations)) return []
    const names: string[] = []
    for (const inst of installations) {
      if (typeof inst?.id !== "number") continue
      const token = await installationTokenFor(inst.id)
      if (!token) continue
      const r = await githubApi("/installation/repositories?per_page=100", token)
      if (r.status !== 200 || !r.json || typeof r.json !== "object") continue
      const repos = (r.json as { repositories?: unknown }).repositories
      if (!Array.isArray(repos)) continue
      for (const repo of repos) {
        if (repo && typeof repo === "object" && typeof (repo as { full_name?: unknown }).full_name === "string") {
          names.push(((repo as { full_name: string }).full_name as string).toLowerCase())
        }
      }
    }
    return [...new Set(names)]
  } catch {
    return []
  }
}
/** App JWT for GitHub API calls ("" when App credentials are absent). */
function githubAppJwt(): string {
  const appId = (process.env.GITHUB_APP_ID ?? "").trim()
  let key = (process.env.GITHUB_PRIVATE_KEY ?? "").trim()
  if (!appId || !key) return ""
  if (!key.includes("BEGIN")) {
    try {
      key = readFileSync(key, "utf8")
    } catch {
      return ""
    }
  }
  try {
    return createAppJwt(appId, key)
  } catch {
    return ""
  }
}

/** Installation id covering a repo owner (""). */
async function installationIdForOwner(owner: string): Promise<number> {
  const jwt = githubAppJwt()
  if (!jwt) return 0
  try {
    const res = await fetch("https://api.github.com/app/installations", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "trayambak",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    })
    const list = (await res.json()) as Array<{ id?: unknown; account?: { login?: unknown } }>
    if (!res.ok || !Array.isArray(list)) return 0
    const found = list.find(
      (i) => i && typeof i.account?.login === "string" && i.account.login.toLowerCase() === owner.toLowerCase(),
    )
    return typeof found?.id === "number" ? found.id : 0
  } catch {
    return 0
  }
}

/** Short-lived installation token ("" on any failure). */
async function installationTokenFor(installationId: number): Promise<string> {
  const jwt = githubAppJwt()
  if (!jwt || !installationId) return ""
  try {
    const apiBase = process.env.GITHUB_API_BASE ?? "https://api.github.com"
    return await createInstallationToken(apiBase, jwt, installationId)
  } catch {
    return ""
  }
}

/** Serve one README image by exact filename. Whitelist-only (no dots
 *  beyond the extension, no slashes): traversal is impossible because the
 *  name can never name a directory. Never throws (async boundary). */
async function serveReadmeImage(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  imgDir: string,
  pathname: string,
): Promise<void> {
  try {
    const name = pathname.slice("/img/".length)
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg)$/i.test(name)) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
      return
    }
    const { readFile } = await import("node:fs/promises")
    const data = await readFile(pathJoin(imgDir, name))
    const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg"
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" })
    res.end(data)
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  }
}

/** Serve one docs page by exact filename (*.md only, same whitelist
 *  discipline as images). Renders as markdown text — readable anywhere,
 *  including the npm README links. Never throws. */
async function serveDocsFile(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  docsDir: string,
  pathname: string,
): Promise<void> {
  try {
    const name = pathname.slice("/docs/".length)
    if (!/^[A-Za-z0-9_-]+\.md$/i.test(name)) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
      return
    }
    const { readFile } = await import("node:fs/promises")
    const data = await readFile(pathJoin(docsDir, name))
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" })
    res.end(data)
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  }
}

/** Machine identity guard for licensing routes: non-empty short string.
 *  Returns "" when missing/invalid (callers answer 400). */
function licenseMachineId(value: unknown): string {
  if (typeof value !== "string") return ""
  const t = value.trim()
  return t.length >= 4 && t.length <= 128 ? t : ""
}

/** GitHub REST call with a user token. Never throws — transport failure is
 *  `{status: 0, json: null}` so routes answer 502 instead of crashing.
 *  Reads are GET by default; `write` switches to POST/PUT/PATCH with a JSON
 *  body (VPS-routed agent writes ride this — the token never leaves). */
async function githubApi(
  path: string,
  token: string,
  timeoutMs = 20_000,
  write?: { method: "POST" | "PUT" | "PATCH"; body: unknown },
): Promise<{ status: number; json: unknown }> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "trayambak",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    }
    const init: RequestInit = { headers, signal: AbortSignal.timeout(timeoutMs) }
    if (write) {
      headers["Content-Type"] = "application/json"
      init.method = write.method
      init.body = JSON.stringify(write.body)
    }
    const res = await fetch(`https://api.github.com${path}`, init)
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // Non-JSON (proxy error page) — status carries it.
    }
    return { status: res.status, json }
  } catch {
    return { status: 0, json: null }
  }
}

/** Best-effort `message` from a GitHub error body ("" when unparseable). */
function githubErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string") {
    return (json as { message: string }).message
  }
  return `HTTP ${status}`
}

/** Encode a contents-API path segment by segment: encodeURIComponent() over
 *  the whole path turns `src/x.ts` into `src%2Fx.ts`, which the contents API
 *  resolves as a single literal segment and 404s on every nested file. */
function encodeContentPath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

/** Best-effort client IP behind nginx + Cloudflare: CF-Connecting-IP first
 *  (set by Cloudflare), then the leftmost X-Forwarded-For hop (nginx
 *  appends), then X-Real-IP, then the socket. Loopback-only bind means no
 *  client can spoof these headers by connecting directly. */
function clientIp(req: http.IncomingMessage): string {
  const pick = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() ?? ""
  return (
    pick(req.headers["cf-connecting-ip"]) ||
    pick(req.headers["x-forwarded-for"]) ||
    pick(req.headers["x-real-ip"]) ||
    req.socket.remoteAddress ||
    "unknown"
  )
}

/**
 * Execute an accepted GitHub job: run the agent in the job workspace, then
 * report back on the thread. Replies need App credentials (GITHUB_APP_ID +
 * GITHUB_PRIVATE_KEY, PEM text or a path to it); without them the run still
 * executes but the result only lands in the server log — fail loud, never
 * silent, so a misconfigured VPS is obvious, not mysterious.
 */
async function runGithubJob(job: GithubJob, payload: unknown): Promise<string> {
  const apiBase = process.env.GITHUB_API_BASE ?? "https://api.github.com"
  const started = new Date().toISOString()
  process.stdout.write(`[github-app] job ${job.repoFullName}#${job.issueNumber} started at ${started}\n`)
  const workspace = process.env.TRAYAMBAK_GITHUB_WORKSPACE ?? loadConfig().cwd
  const baseConfig = loadConfig()
  // The /trayambak comment IS the user's approval for repo work: allow the
  // github API tool outright (it rides the 1-hour installation token, so it
  // cannot reach beyond the installed repos). Everything else keeps the
  // operator's rules — headless runs stay denied-by-default elsewhere.
  // Without this, write_file calls die at the permission ladder and the
  // thread gets "blocked by the permission ruleset" instead of a commit
  // (observed live).
  const jobConfig = {
    ...baseConfig,
    cwd: workspace,
    permissions: {
      ...baseConfig.permissions,
      rulesV2: [
        ...(baseConfig.permissions?.rulesV2 ?? []),
        {
          tool: "github",
          action: "allow" as const,
          reason: "GitHub App job: comment-authorized, installation-token scoped",
        },
      ],
    },
  }
  const agent = new Agent({ config: jobConfig })
  // Credentials first: the reply needs them, and so does the run itself —
  // the agent's github tool reads GITHUB_TOKEN, so lend it the installation
  // token for the duration of the run (restored in `finally`). Without this
  // the agent works blind and reports phantom 404s on public repos
  // (observed live). No creds = run still executes, reply only via log.
  const appId = process.env.GITHUB_APP_ID ?? ""
  let key = process.env.GITHUB_PRIVATE_KEY ?? ""
  if (key && !key.includes("BEGIN")) {
    const fs = await import("node:fs")
    try {
      key = fs.readFileSync(key, "utf8")
    } catch {
      key = ""
    }
  }
  const installation = (payload as { installation?: { id?: unknown } } | null)?.installation
  const installationId = typeof installation?.id === "number" ? installation.id : 0
  let installToken = ""
  if (appId && key && installationId) {
    try {
      installToken = await createInstallationToken(apiBase, createAppJwt(appId, key), installationId)
    } catch (err) {
      process.stdout.write(
        `[github-app] installation token mint failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
  // Never reply blank: a thrown run becomes an honest error message, a
  // tool-only run falls back to the last tool text (extractFinalReply).
  // Either way the thread shows WHAT happened, not silence.
  let messages: Array<{ role?: string; content?: unknown }> = []
  let runError = ""
  // Provider failures surface as error message_end emits that never enter
  // the session (the loop breaks on them) — collect them here or the real
  // cause evaporates (observed live: blank thread replies, zero diagnosis).
  const errorTexts: string[] = []
  // Failed tool results (first 300 chars, error-looking only — never file
  // contents): the shape log proves tools FIRED but not what they SAID.
  // Observed live: the agent reported "permission denied" while the shape
  // showed healthy tool calls — without this the API's real answer is
  // invisible.
  const toolDiags: string[] = []
  const emit = (event: { type?: string; message?: unknown; used?: unknown; max?: unknown }): void => {
    try {
      if (event?.type === "budget_exhausted") {
        errorTexts.push(
          `Budget exhausted (used ${typeof event.used === "number" ? event.used : "?"} of ${typeof event.max === "number" ? event.max : "?"}) — the run stopped before the model was called.`,
        )
        return
      }
      if (event?.type === "message_end") {
        const msg = event.message as { role?: unknown; stopReason?: unknown; content?: unknown } | undefined
        if (msg?.stopReason === "error" && Array.isArray(msg.content)) {
          const t = msg.content
            .filter(
              (p): p is { type: "text"; text: string } =>
                !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
            )
            .map((p) => p.text)
            .join("\n")
            .trim()
          if (t) errorTexts.push(t)
        }
        // Tool diagnostics: role tool + smells like failure → log excerpt.
        if (msg?.role === "tool" && Array.isArray(msg.content)) {
          const t = msg.content
            .filter(
              (p): p is { type: "text"; text: string } =>
                !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
            )
            .map((p) => p.text)
            .join("\n")
          if (t && /fail|error|denied|not found|404|401|403|refus/i.test(t)) {
            toolDiags.push(t.slice(0, 300))
          }
        }
      }
    } catch {
      // Collector must never break the run.
    }
  }
  try {
    const prevGhToken = process.env.GITHUB_TOKEN
    if (installToken) process.env.GITHUB_TOKEN = installToken
    // The webhook payload already carries the issue + triggering comment:
    // hand them over verbatim so the agent starts informed, not blind.
    const thread = describeGithubThread(payload)
    try {
      messages = (await agent.run(
        `GitHub request in ${job.repoFullName}${job.isPullRequest ? " (pull request" : " (issue"} #${job.issueNumber}):\n${job.task}\n\nYou have repo access via the github tool (GITHUB_TOKEN is set for this run) — read the actual issue/PR first (read_issue), never claim access errors without trying the tool. If the tool says Not Found on the repository itself, the App is not installed there: tell the user to install it (GitHub App settings → Install App → that repository) instead of guessing further.${thread ? `\n\nContext from GitHub:\n${thread}` : ""}`,
        emit,
      )) as Array<{ role?: string; content?: unknown }>
    } finally {
      // Restore whatever the operator configured (usually nothing).
      if (installToken) {
        if (prevGhToken === undefined) delete process.env.GITHUB_TOKEN
        else process.env.GITHUB_TOKEN = prevGhToken
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err)
  }
  const reply = selectJobReply(messages, runError, errorTexts)
  // Durable job history: every run leaves a row (repo/issue/task-head/
  // reply-head), independent of log rotation.
  recordJob({
    repo: job.repoFullName,
    issue: job.issueNumber,
    task: job.task,
    messages: messages.length,
    replyHead: reply,
    ...(runError ? { error: runError } : {}),
  })
  const shape = messages
    .map((m) => {
      const types = Array.isArray(m.content)
        ? m.content.map((p) => (p as { type?: unknown } | null)?.type ?? "?").join("+")
        : typeof m.content
      return `${m.role ?? "?"}[${types}]`
    })
    .join(" ")
  process.stdout.write(
    `[github-app] job ${job.repoFullName}#${job.issueNumber} finished (${messages.length} messages: ${shape || "none"}${runError ? `, error: ${runError.slice(0, 200)}` : ""}${toolDiags.length > 0 ? `, toolDiags: ${toolDiags.join(" || ").slice(0, 600)}` : ""})\n`,
  )
  if (!appId || !key || !installationId || !installToken) {
    process.stdout.write(
      `[github-app] job done but no reply channel (need GITHUB_APP_ID + GITHUB_PRIVATE_KEY + installation id + token mint).\n--- result ---\n${reply}\n--- end ---\n`,
    )
    return reply
  }
  const { owner, repo } = splitRepo(job.repoFullName)
  const capped = reply.length > 60000 ? `${reply.slice(0, 60000)}\n\n…(truncated, full log on the VPS)` : reply
  await postIssueComment(
    { apiBase, token: installToken },
    owner,
    repo,
    job.issueNumber,
    `## Trayambak result\n\n${capped}`,
  )
  process.stdout.write(`[github-app] job ${job.repoFullName}#${job.issueNumber} replied\n`)
  return reply
}

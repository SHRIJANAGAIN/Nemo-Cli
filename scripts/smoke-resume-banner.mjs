/* Full-app E2E for the resume-duplication bug (user report: "RESUME
 * MESSAGE BUG" — "Resumed session: New conversation" scattered 2-4x
 * through a transcript).
 *
 * Root cause (three layers, all fixed):
 *   1. addSystemMessage persisted the resume banner into log.jsonl, so a
 *      session resumed N times ACCUMULATED N banners (real sessions had
 *      up to 4 — sess_mudu9czr had 4).
 *   2. loadConversation restored them as history, wedging stale banners
 *      mid-transcript (the visible bug).
 *   3. Re-picking the live session reloaded state from disk (which lags:
 *      replies persist on message_end) and stacked another banner.
 *
 * This drives the REAL TrayambakApp (dist) against a sandboxed,
 * deliberately polluted store and asserts:
 *   - the picker restores the history WITHOUT the stale banners,
 *   - exactly ONE fresh banner renders, AFTER the restored messages,
 *   - nothing was written back: log.jsonl gains no banner (layer 1) and
 *     the restore re-appends nothing (state replace stays state-only).
 *
 * Frame/window discipline (same idea as smoke-app-submit): the sink is an
 * append-only byte stream, so each phase resets it JUST BEFORE the action
 * and assertions only read bytes written since. The restored transcript
 * reaches stdout exactly once (Ink <Static> flush on the epoch remount),
 * so banner counts in the post-select window are per-transcript counts.
 *
 * Run: node scripts/smoke-resume-banner.mjs
 */
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href;

// ── Sandboxed session store, polluted the way the old build polluted it ──
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-resume-"));
const convDir = path.join(sandbox, "skt", "8-conversations");
fs.mkdirSync(path.join(convDir, "sess_smoke1"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "resume-smoke" }));
// Seeded session sits in the store; boot must NOT surface it (first screen),
// and /sessions must open the picker on demand.
fs.writeFileSync(
  path.join(convDir, "sessions.json"),
  JSON.stringify(
    [
      {
        sessionId: "sess_smoke1",
        sessionName: "Alpha Chat",
        sessionDescription: "",
        startedAt: "2026-09-25T10:00:00.000Z",
        messageCount: 0,
        totalTokens: 0,
        status: "active",
      },
    ],
    null,
    2,
  ),
);
const logFile = path.join(convDir, "sess_smoke1", "log.jsonl");
const ts = "2026-09-25T10:00:00.000Z";
const polluted = [
  { role: "user", content: "alpha-start", ts },
  { role: "system", content: "Resumed session: New conversation", ts },
  { role: "assistant", content: "alpha-reply", ts },
  { role: "system", content: "Resumed session: New conversation", ts },
  { role: "user", content: "alpha-end", ts },
];
const seededLines = polluted.length;
fs.writeFileSync(logFile, polluted.map((e) => JSON.stringify(e)).join("\n") + "\n");

// session.ts resolves its store from TRAYAMBAK_HOME at CALL time.
process.env.TRAYAMBAK_HOME = sandbox;

// ── Fake TTY (byte-for-byte what a real terminal delivers) ───────────────
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 154;
stdout.rows = 40;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`);
const sanitizedStdin = createSanitizedStdin(stdin);

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(`${distEsm}/index.js`);

const stripAnsi = (text) =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const countIn = (hay, needle) => hay.split(needle).length - 1;

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      themeName: "trayambak-dark", // skip ThemePicker
      baseUrl: "http://127.0.0.1:9/api", // unroutable — no network ever needed
      apiKey: "test-key",
      model: "test/model",
      cwd: process.cwd(),
    },
    modelName: "test/model",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
  if (!ok) {
    failures += 1;
    console.error("--- window tail ---");
    console.error(stripAnsi(sink).slice(-700));
  }
};

// ── 1. Boot: first screen — the picker must NOT auto-open ─────────────────
await wait(900);
check(
  !stripAnsi(sink).includes("Alpha Chat"),
  "boot shows the first screen (seeded session NOT auto-listed)",
);

// ── 1b. Open the picker on demand: /sessions ──────────────────────────────
sink = "";
stdin.write("/sessions");
await wait(150);
stdin.write("\r");
await wait(500);
check(stripAnsi(sink).includes("Alpha Chat"), "/sessions opens the picker (seeded session listed)");

// ── 2. Select it: DOWN past the "+ New Chat" row, then Enter ─────────────
sink = "";
stdin.write("\x1b[B");
await wait(150);
stdin.write("\r");
await wait(900);
const view = stripAnsi(sink);

check(view.includes("Resumed session: Alpha Chat"), "fresh resume banner rendered after select");
check(
  !view.includes("Resumed session: New conversation"),
  "stale banners NOT restored into the transcript (read-side filter)",
);
check(view.includes("alpha-reply"), "history restored around the old banners");
// The transcript sits in MessageList's DYNAMIC tail (3 short messages fit
// the in-frame budget), so every frame rewrite re-prints it — an append-
// only sink accumulates N copies while a real terminal erases each prior
// frame. The stacking invariant is therefore RATIO-based: every rendered
// transcript copy must carry exactly one banner.
const banners = countIn(view, "Resumed session");
const starts = countIn(view, "alpha-start");
if (starts === 0 || banners !== starts) {
  const allIdx = (hay, needle) => {
    const out = [];
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push(at);
      at = hay.indexOf(needle, at + needle.length);
    }
    return out;
  };
  console.error("--- diagnostic ---");
  console.error("alpha-start at:", allIdx(view, "alpha-start"));
  console.error("Resumed at:", allIdx(view, "Resumed session"));
}
check(
  starts > 0 && banners === starts,
  `exactly one banner per rendered transcript (banners=${banners}, alpha-start=${starts})`,
);
const endAt = view.indexOf("alpha-end");
const bannerAt = view.indexOf("Resumed session");
check(
  endAt !== -1 && bannerAt > endAt,
  "banner sits AFTER the restored history (not wedged mid-transcript)",
);

// ── 3. Disk: banner is transcript-only; restore never writes ─────────────
const logText = fs.readFileSync(logFile, "utf8");
// The 2 stale banners are SEEDED pollution — the fix is read-side, so the
// file keeps them. What must NOT happen: the fresh banner being appended
// (layer 1 regressing) → count would exceed the seeded 2.
const seededBanners = polluted.filter((e) => e.role === "system").length;
const fileBanners = countIn(logText, "Resumed session");
check(
  fileBanners === seededBanners,
  `banner never persisted back into log.jsonl (file has ${fileBanners}, seeded ${seededBanners})`,
);
const lineCount = logText.split("\n").filter((l) => l.trim()).length;
// A restore that re-appended history would at least double the file. (A
// boot-time update notice can legitimately add one line to SOME session —
// never to this one before select — so keep one line of slack.)
check(lineCount <= seededLines + 1, `restore re-appended nothing (${lineCount} lines, seeded ${seededLines})`);

instance.unmount();
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(failures === 0 ? "RESUME_SMOKE_OK" : `RESUME_SMOKE_FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);

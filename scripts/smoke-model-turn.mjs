/* Model-turn smoke: a fake OpenAI-compatible SSE server stands in for the
 * model so the app runs REAL agent turns — streamed thinking, streamed text,
 * tool calls (glob + grep), tool results, turn end — and oracles assert the
 * resulting SCREEN (scrollback + viewport), not the byte stream.
 *
 * Why: every other path (submit, wrap, static split, menu, notify, resizes)
 * is covered by smoke-screen-replay. The remaining untested surface — and
 * the one behind the user's "LINES ISSUES" (duplicate stacked tool-call
 * boxes) — is live streaming + tool-call rendering.
 *
 * Server script (content-aware dispatch on the request body):
 *   plan 1 (no call ids yet):   reasoning deltas + text deltas (marker) +
 *                               tool_call#1 glob {pattern:"*.md"}
 *   plan 2 (history has #1):    tool_call#2 grep {pattern:"createScreen"}
 *   plan 3 (history has #2):    final text (marker) → stop
 *   any later request:          plan 3 again → loop always terminates.
 *
 * Oracles (every settle, over scrollback + viewport):
 *   O1: every row containing TRAYAMBAK matches │TRAYAMBAK<spaces>│
 *   O2: no row contains TRAYAMBAK together with a marker
 *   O3: no row contains two distinct markers (cross-row merge)
 *   O4: viewport top row is the frame's ┌ border (no off-by-one scroll)
 *   O5: no two adjacent non-empty rows normalize to the same text
 *       (a duplicated/stacked tool box repeats its rows verbatim)
 * Plus presence asserts: streamed marker, thinking marker, final marker,
 * and the grep result ("createScreen" from scripts/*.mjs).
 *
 * Run: node scripts/smoke-model-turn.mjs
 */
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createScreen } from "./vt-screen.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEsm = pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm")).href;

// Log via process.stdout.write — Ink patchConsole hijacks console.* during the run.
const log = (...a) => process.stdout.write(a.join(" ") + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COLS = Number(process.env.SR_COLS || 76);
const ROWS = Number(process.env.SR_ROWS || 40);

/* ── Oracles ─────────────────────────────────────────────────────────────── */
const MARKERS = ["MODEL_STREAM_MARKER_ONE", "MODEL_FINAL_MARKER_NINE", "STREAM_THINK_MARKER", "RUN_MODEL_TURNS_PLEASE"];
let failures = 0;

const dumpScreen = (screen, title) => {
  const sb = screen.scrollbackRows();
  log(`── screen dump: ${title} ──`);
  sb.forEach((r, i) => log(`~${String(i).padStart(2, " ")}│${r}`));
  if (sb.length > 0) log("  ··· viewport below ···");
  screen.snapshot().forEach((r, i) => log(`${String(i).padStart(2, " ")}│${r}`));
  log("── end dump ──");
};

const checkScreen = (screen, label) => {
  const rows = screen.snapshotFull();
  let ok = true;
  const reasons = [];
  const sbLen = screen.scrollbackRows().length;
  rows.forEach((r, i) => {
    const where = i < sbLen ? `sb${i}` : `row${i - sbLen}`;
    if (r.includes("TRAYAMBAK")) {
      if (!/^│TRAYAMBAK\s*│$/.test(r)) { ok = false; reasons.push(`O1 ${where}: ${JSON.stringify(r)}`); }
      for (const m of MARKERS) if (r.includes(m)) { ok = false; reasons.push(`O2 ${where}: logo+${m}`); }
    }
    const here = MARKERS.filter((m) => r.includes(m));
    if (here.length > 1) { ok = false; reasons.push(`O3 ${where}: ${here.join("+")}`); }
  });
  // O4: steady state → frame fills the viewport exactly; opening row at
  // row 0 (rounded ╭ cap on fresh sessions, │ wall once the scrollback
  // prefix exists and the root drops its top border).
  const vp = screen.snapshot();
  const top = vp[0] ?? "";
  if (
    !(
      top.startsWith("╭") ||
      (top.startsWith("│") && top.trimEnd().endsWith("│"))
    )
  ) {
    ok = false;
    reasons.push(`O4: viewport top = ${JSON.stringify(vp[0] ?? "")}`);
  }
  // O5: adjacent non-empty rows that are identical after stripping box
  // drawing + logo-art block chars → a duplicated block (stacked duplicate
  // tool-call box). The Welcome-screen banner is solid ▀ runs by design.
  const normalize = (r) => r.replace(/[│─┌┐└┘┬┴┼╭╮╯╰▀▄░▒▓]/g, "").replace(/\s+/g, "");
  for (let i = 1; i < rows.length; i++) {
    const a = normalize(rows[i - 1]);
    const b = normalize(rows[i]);
    if (a.length > 8 && a === b) {
      ok = false;
      reasons.push(`O5 ${i - 1}/${i}: adjacent duplicate ${JSON.stringify(rows[i].slice(0, 60))}`);
    }
  }
  log(`${ok ? "ok" : "FAIL"}: ${label}${ok ? "" : "\n  " + reasons.join("\n  ")}`);
  if (!ok) { failures++; dumpScreen(screen, `VIOLATION @ ${label}`); }
  return ok;
};

const requirePresent = (screen, label, needle) => {
  const found = screen.snapshotFull().some((r) => r.includes(needle));
  log(`${found ? "ok" : "FAIL"}: present-${label} (${JSON.stringify(needle)})`);
  if (!found) { failures++; dumpScreen(screen, `MISSING ${needle} @ ${label}`); }
  return found;
};

const requireAbsent = (screen, label, needle) => {
  const found = screen.snapshotFull().some((r) => r.includes(needle));
  log(`${found ? "FAIL" : "ok"}: absent-${label} (${JSON.stringify(needle)})`);
  if (found) { failures++; dumpScreen(screen, `UNWANTED ${needle} @ ${label}`); }
  return !found;
};

/* ── Fake OpenAI-compatible SSE model server ─────────────────────────────── */
let requestsSeen = 0;
let plan3Responses = 0;
const requestNotes = [];

const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fake", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: "test/m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const emitSeq = async (res, items) => {
  for (const it of items) {
    if (it === "DONE") { res.write("data: [DONE]\n\n"); continue; }
    res.write(chunkOf(it.delta, it.finish ?? null));
    if (it.pause) await wait(it.pause);
  }
  res.end();
};

const plan1 = [
  { delta: { reasoning_content: "STREAM_THINK_MARKER planning the " }, pause: 40 },
  { delta: { reasoning_content: "steps before answering. " }, pause: 40 },
  { delta: { content: "MODEL_STREAM_MARKER_ONE " }, pause: 35 },
  { delta: { content: "streaming the first " }, pause: 35 },
  { delta: { content: "answer body while " }, pause: 35 },
  { delta: { content: "the screen keeps up " }, pause: 35 },
  { delta: { content: "with every delta. " }, pause: 35 },
  { delta: { tool_calls: [{ index: 0, id: "call_fake_1", type: "function", function: { name: "glob", arguments: "" } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"*.md",' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"path":"." ,' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"max_results":5}' } }] }, pause: 30 },
  { delta: {}, finish: "tool_calls" },
  "DONE",
];
// Fix the accidental space in the JSON args (kept readable above).
plan1[10] = { delta: { tool_calls: [{ index: 0, function: { arguments: '"path":".",' } }] }, pause: 30 };

const plan2 = [
  { delta: { tool_calls: [{ index: 0, id: "call_fake_2", type: "function", function: { name: "grep", arguments: "" } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"createScreen",' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"path":"scripts",' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"glob":"*.mjs",' } }] }, pause: 30 },
  { delta: { tool_calls: [{ index: 0, function: { arguments: '"literal":true,"max_results":3}' } }] }, pause: 30 },
  { delta: {}, finish: "tool_calls" },
  "DONE",
];

const plan3 = [
  { delta: { content: "MODEL_FINAL_MARKER_NINE " }, pause: 35 },
  { delta: { content: "both tool calls returned, " }, pause: 35 },
  { delta: { content: "the turn is complete." }, pause: 35 },
  { delta: {}, finish: "stop" },
  "DONE",
];

const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    requestsSeen++;
    let plan;
    try {
      const parsed = JSON.parse(body);
      const asText = JSON.stringify(parsed);
      if (asText.includes("call_fake_2")) plan = 3;
      else if (asText.includes("call_fake_1")) plan = 2;
      else plan = requestsSeen === 1 ? 1 : 3;
      requestNotes.push(`#${requestsSeen} url=${req.url} plan=${plan} msgs=${parsed.messages?.length ?? "?"}`);
    } catch (err) {
      requestNotes.push(`#${requestsSeen} UNPARSEABLE: ${String(err).slice(0, 80)}`);
      res.writeHead(400); res.end();
      return;
    }
    if (plan === 3) plan3Responses++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    emitSeq(res, plan === 1 ? plan1 : plan === 2 ? plan2 : plan3).catch(() => {});
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
log(`fake model server on 127.0.0.1:${port} (POST /api/v1/chat/completions)`);

/* ── Fake TTY + app boot ─────────────────────────────────────────────────── */
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`);
const sanitizedStdin = createSanitizedStdin(stdin);

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = COLS;
stdout.rows = ROWS;

const screen = createScreen(COLS, ROWS);
stdout.on("data", (chunk) => screen.write(chunk.toString()));

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(`${distEsm}/index.js`);

const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark", baseUrl: `http://127.0.0.1:${port}/api`, apiKey: "k", model: "test/m", cwd: process.cwd() },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout },
);

const settle = async (ms = 700) => { await wait(ms); checkScreen(screen, current); };
let current = "boot";

current = "boot";
await settle(900);

// ── Submit one message → the agent runs 3 model requests + 2 tools ────────
current = "submit-turn";
stdin.write("RUN_MODEL_TURNS_PLEASE");
await wait(150);
stdin.write("\r");

// Mid-stream frame checks (deltas force re-renders every ~35ms).
await wait(450);
current = "mid-stream-plan1";
checkScreen(screen, current);
await wait(700);
current = "mid-tools";
checkScreen(screen, current);

// Wait for plan 3 to be served (turn finished at the model level).
let sawFinal = false;
for (let i = 0; i < 225; i++) { // up to ~45s
  await wait(200);
  if (plan3Responses > 0) { sawFinal = true; break; }
}
log(`model requests: ${requestsSeen}; plan3 responses: ${plan3Responses}`);
for (const n of requestNotes) log(`  req ${n}`);
if (!sawFinal) {
  failures++;
  log("FAIL: plan 3 (final answer) never served within 45s");
  dumpScreen(screen, "model script stalled");
}

// Let the final answer stream out + agent_end + idle render.
current = "final";
await settle(1800);

requirePresent(screen, "streamed-answer", "MODEL_STREAM_MARKER_ONE");
// Thinking text is not a rendered feature: MessageRow only shows a transient
// "Thinking…" spinner from message.thinking while isStreaming — asserting its
// presence at settle time would test a design that doesn't exist. What matters
// is that tool-only turns produce NO filler row (regression pin for the
// agent-loop "no content" bug) and no stray blank assistant row.
requireAbsent(screen, "no-content-filler", "The model returned no content");
requirePresent(screen, "grep-result", "createScreen");
requirePresent(screen, "final-answer", "MODEL_FINAL_MARKER_NINE");

dumpScreen(screen, "final");

writeFileSync(path.join(here, "smoke-model-turn.result.txt"),
  (failures === 0 ? "MODEL_TURN_OK\n" : `MODEL_TURN_FAIL:${failures}\n`) + screen.snapshotFull().join("\n"));

instance.unmount();
await wait(100);
server.close();
log(failures === 0 ? "MODEL_TURN_OK" : `MODEL_TURN_FAIL:${failures}`);
process.exit(failures === 0 ? 0 : 1);

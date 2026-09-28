/* Headless E2E for the enhance composer flow (SKT AI LABS sparkle port):
 * ctrl+e rewrites the buffer in place, /enhance <draft> intercepts Enter,
 * failures stay inline with the draft intact, empty buffer gives a hint.
 * Buffer contents are proven via Enter -> onSubmit (this Ink has no lastFrame). */
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 110;
stdout.rows = 40;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const React = (await import("react")).default;
const { render } = await import("ink");
const { PromptInput } = await import(
  pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", "PromptInput.js")).href
);

const calls = [];
const onEnhance = async (draft) => {
  calls.push(draft);
  if (draft === "fail me") return { ok: false, error: "HTTP 500 boom" };
  return { ok: true, text: `ENHANCED(${draft})` };
};

const submitted = [];
const instance = render(
  React.createElement(PromptInput, {
    onSubmit: (value) => submitted.push(value),
    onSlashCommand: () => {},
    onChoose: () => {},
    onEnhance,
    commandList: [],
  }),
  { stdin, stdout },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const seen = () => stripAnsi(sink);

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log("ok:", label);
  } else {
    failures += 1;
    console.error("FAIL:", label);
    console.error("--- stripped sink tail ---");
    console.error(seen().slice(-600));
  }
}
async function submitCurrent() {
  stdin.write("\r");
  await wait(150);
}

// 1. Type a draft (separate chunks — ink coalesces per write), then Ctrl+E.
stdin.write("fix the login bug");
await wait(120);
assert(seen().includes("fix the login bug"), "draft typed into buffer");
stdin.write("\x05");
await wait(200);
assert(calls[0] === "fix the login bug", "ctrl+e enhanced the draft: " + JSON.stringify(calls));
await submitCurrent();
assert(submitted[0] === "ENHANCED(fix the login bug)", "rewrite was in the buffer: " + JSON.stringify(submitted));

// 2. Failure keeps the draft and shows the error inline.
stdin.write("\x0c"); // ctrl+l clear
await wait(80);
stdin.write("fail me");
await wait(80);
stdin.write("\x05");
await wait(200);
assert(calls[1] === "fail me", "second ctrl+e enhanced new draft");
assert(seen().includes("HTTP 500 boom"), "error shown inline");
await submitCurrent();
assert(submitted[1] === "fail me", "draft preserved after failure: " + JSON.stringify(submitted[1]));

// 3. Empty buffer -> hint, no network.
stdin.write("\x0c");
await wait(80);
const before = calls.length;
stdin.write("\x05");
await wait(150);
assert(calls.length === before, "empty buffer made no enhance call");
assert(seen().includes("Nothing to enhance"), "empty buffer hint shown");

// 4. /enhance <draft> slash path -> Enter intercepted, rewrite lands in buffer.
stdin.write("/enhance make it fast");
await wait(120);
stdin.write("\r");
await wait(250);
assert(
  calls[calls.length - 1] === "make it fast",
  "slash enhanced its args: " + JSON.stringify(calls[calls.length - 1]),
);
assert(submitted.length === 2, "/enhance did not submit the command");
assert(seen().includes("ENHANCED(make it fast)"), "slash rewrite rendered");
await submitCurrent();
assert(submitted[2] === "ENHANCED(make it fast)", "slash rewrite was in the buffer: " + JSON.stringify(submitted[2]));

instance.unmount();
console.log(failures === 0 ? "UI_SMOKE_OK" : `UI_SMOKE_FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);

/* Debug: where do the "Thinking" occurrences in the last frame come from?
 * Mirrors message-list-static.test.ts cases A (thinking present) and B
 * (no thinking yet) and prints the last 12 stripped sink lines. */
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEsm = pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm")).href;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const openStdio = () => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 40 });
  let buf = "";
  stdout.on("data", (c) => { buf += c.toString(); });
  return { stdin, stdout, sink: () => buf };
};

const React = (await import("react")).default;
const { render } = await import("ink");
const { MessageList } = await import(`${distEsm}/MessageList.js`);

const run = async (label, messages, props) => {
  const { stdin, stdout, sink } = openStdio();
  const instance = render(
    React.createElement(MessageList, { messages, ...props }),
    { stdin, stdout, patchConsole: false },
  );
  await wait(400);
  const stripped = stripAnsi(sink());
  const lines = stripped.split("\n");
  const tail = lines.slice(-12);
  const hits = tail.join("\n").split("Thinking").length - 1;
  console.log(`\n=== ${label} — tail hits=${hits} (total sink hits=${stripped.split("Thinking").length - 1}) ===`);
  tail.forEach((l, i) => console.log(`${String(lines.length - 12 + i).padStart(3)}|${l}`));
  instance.unmount();
  await wait(60);
};

await run(
  "A: thinking + isStreaming + isLoading",
  [{ id: "a-live", role: "assistant", content: "partial answer", thinking: "live reasoning" }],
  { isStreaming: true, isLoading: true },
);

await run(
  "B: no thinking + isStreaming + isLoading",
  [
    { id: "u1", role: "user", content: "hi" },
    { id: "a-soon", role: "assistant", content: "" },
  ],
  { isStreaming: true, isLoading: true },
);

process.exit(0);

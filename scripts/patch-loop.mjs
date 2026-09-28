/* TEMP one-shot patch — delete after use. ASCII only. */
import fs from "node:fs";
const f = "C:/Users/engli/trayambak/apps/runtime/src/agent/agent-loop.ts";
const src = fs.readFileSync(f, "utf8");
const anchor =
  "  const state = { toolCalls: 0, callTimes: [] as number[], distinctTools: new Set<string>(), recentCalls: [] as string[] };\r\n";
const insert =
  "  const seenInboxIds = new Set<string>();\r\n";
if (!src.includes(anchor)) {
  console.log("ANCHOR MISSING");
  process.exit(1);
}
const out1 = src.replace(anchor, anchor + insert);
const abortBlock =
  "    if (run.signal?.aborted) {\r\n" +
  "      await run.emit({ type: \"agent_end\", messages: run.session.messages });\r\n" +
  "      return run.session.messages;\r\n" +
  "    }\r\n";
const poll =
  "    // Inbox delivery: a messageable subagent folds newly arrived inbox\r\n" +
  "    // messages in as user turns, so trayambak__SendMessage continues it\r\n" +
  "    // with context intact instead of appending to a file nobody reads.\r\n" +
  "    // Best-effort (never break a turn over inbox IO) and abort-aware.\r\n" +
  "    if (run.inboxId && !run.signal?.aborted) {\r\n" +
  "      try {\r\n" +
  "        for (const m of readInbox(run.inboxId)) {\r\n" +
  "          if (seenInboxIds.has(m.id)) continue;\r\n" +
  "          seenInboxIds.add(m.id);\r\n" +
  "          run.session.add({ role: \"user\", content: \"[message from \" + m.from + \"]: \" + m.content });\r\n" +
  "        }\r\n" +
  "      } catch {\r\n" +
  "        /* inbox is best-effort */\r\n" +
  "      }\r\n" +
  "    }\r\n";
if (!out1.includes(abortBlock)) {
  console.log("ABORT BLOCK MISSING");
  process.exit(1);
}
const out2 = out1.replace(abortBlock, abortBlock + poll);
fs.writeFileSync(f, out2, "utf8");
console.log("patched");

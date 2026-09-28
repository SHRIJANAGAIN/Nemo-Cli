/* Dist smoke for prompt enhancement (SKT AI LABS sparkle port). */
const path = require("path");
const os = require("os");
const fs = require("fs");

const m = require(path.join(__dirname, "..", "dist", "apps", "runtime", "src", "prompt", "enhance-prompt.js"));

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok:", label);
}

assert(typeof m.INSTRUCTION === "string" && m.INSTRUCTION.startsWith("You rewrite draft user prompts"), "INSTRUCTION present");
assert(m.clean("```\nrewrite\n```") === "rewrite", "clean strips fences");
assert(m.clean("'quoted rewrite'") === "quoted rewrite", "clean strips quotes");
assert(
  m.chatCompletionsUrl("https://integrate.api.nvidia.com") === "https://integrate.api.nvidia.com/v1/chat/completions",
  "nvidia endpoint",
);
assert(m.chatCompletionsUrl("http://localhost:8080") === "http://localhost:8080/chat/completions", "local endpoint");

async function main() {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "```\nEnhanced draft text\n```" } }] }),
      text: async () => "",
    };
  };

  const out = await m.enhancePrompt("fix the thing", {
    baseUrl: "https://integrate.api.nvidia.com",
    apiKey: "k",
    model: "nvidia/model-x",
    fetchImpl,
  });

  assert(out === "Enhanced draft text", "enhancePrompt returns cleaned rewrite: " + JSON.stringify(out));
  assert(captured.url === "https://integrate.api.nvidia.com/v1/chat/completions", "posts to chat/completions");
  const body = JSON.parse(captured.init.body);
  assert(body.temperature === 0.7, "temperature 0.7 (SKT AI LABS)");
  assert(body.messages[0].content === m.INSTRUCTION, "system = INSTRUCTION");
  assert(body.messages[1].content.startsWith("Draft prompt to enhance, not answer:"), "draft labeled");
  assert(captured.init.headers.Authorization === "Bearer k", "auth header");

  // Error path keeps the draft safe (throws; composer catches inline).
  let threw = false;
  await m.enhancePrompt("x", {
    baseUrl: "https://integrate.api.nvidia.com",
    model: "m",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }),
  }).catch(() => {
    threw = true;
  });
  assert(threw, "non-ok response throws (composer shows inline error)");

  // Optional live E2E: only if the user's config carries an api key.
  let live = "skipped (no api key)";
  try {
    const cfgPath = path.join(os.homedir(), ".trayambak", "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg.apiKey) {
        const text = await m.enhancePrompt("fix login bug", {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          timeoutMs: 45000,
        });
        live = "LIVE OK -> " + text.replace(/\s+/g, " ").slice(0, 140);
      }
    }
  } catch (error) {
    live = "LIVE FAILED -> " + (error && error.message ? error.message : String(error));
  }
  console.log("live:", live);

  console.log("SMOKE_OK");
}

main().catch((error) => {
  console.error("SMOKE_FAIL", error);
  process.exit(1);
});

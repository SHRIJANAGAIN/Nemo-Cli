# Providers

Trayambak talks to **22 backends** through one config surface. The list is the
`provider` enum in `apps/runtime/src/config.ts` and `config.schema.json`;
per-backend defaults come from `PROVIDER_CATALOG` in
`packages/provider/src/catalog.ts`.

## The 22 backends

| Provider id   | Label             | Default base URL                                            | Default model                                | Key          |
| ------------- | ----------------- | ----------------------------------------------------------- | -------------------------------------------- | ------------ |
| `nvidia`      | NVIDIA            | `https://integrate.api.nvidia.com`                          | `nvidia/nemotron-3-super-120b-a12b`          | required     |
| `nvidia-nim`  | NVIDIA NIM        | `https://integrate.api.nvidia.com`                          | `nvidia/nemotron-3-super-120b-a12b`          | required     |
| `openai`      | OpenAI            | `https://api.openai.com`                                    | `gpt-4o`                                     | required     |
| `anthropic`   | Anthropic         | `https://api.anthropic.com`                                 | `claude-3-5-sonnet-latest`                   | required     |
| `google`      | Google            | `https://generativelanguage.googleapis.com/v1beta`          | `gemini-2.5-flash`                           | required     |
| `xai`         | xAI Grok          | `https://api.x.ai`                                          | `grok-4`                                     | required     |
| `huggingface` | Hugging Face      | `https://router.huggingface.co/v1`                          | `meta-llama/Llama-3.3-70B-Instruct`          | required     |
| `ollama`      | Ollama            | `http://localhost:11434`                                    | `llama3.1`                                   | none (local) |
| `custom`      | Custom endpoint   | `http://localhost:8080`                                     | _(none — you must set one)_                  | optional     |
| `llamacpp`    | llama.cpp (local) | _no per-provider default — use your `trayambak serve` port_ | _no per-provider default — set your GGUF id_ | none (local) |
| `groq`        | Groq              | `https://api.groq.com/openai/v1`                            | `llama-3.3-70b-versatile`                    | required     |
| `mistral`     | Mistral           | `https://api.mistral.ai/v1`                                 | `mistral-large-latest`                       | required     |
| `cerebras`    | Cerebras          | `https://api.cerebras.ai/v1`                                | `llama3.1-70b`                               | required     |
| `together`    | Together AI       | `https://api.together.xyz/v1`                               | `meta-llama/Llama-3.3-70B-Instruct-Turbo`    | required     |
| `deepinfra`   | DeepInfra         | `https://api.deepinfra.com/v1/openai`                       | `meta-llama/Llama-3.3-70B-Instruct`          | required     |
| `cohere`      | Cohere            | `https://api.cohere.com/compatibility/v1`                   | `command-r-plus`                             | required     |
| `perplexity`  | Perplexity        | `https://api.perplexity.ai`                                 | `sonar-pro`                                  | required     |
| `openrouter`  | OpenRouter        | `https://openrouter.ai/api/v1`                              | `anthropic/claude-sonnet-4`                  | required     |
| `fireworks`   | Fireworks AI      | `https://api.fireworks.ai/inference/v1`                     | `accounts/fireworks/models/llama-v3p3-70b-instruct` | required |
| `venice`      | Venice AI         | `https://api.venice.ai/api/v1`                              | `llama-3.3-70b`                              | required     |
| `azure`       | Azure OpenAI      | `https://YOUR-RESOURCE.openai.azure.com/openai/deployments` | `gpt-4o`                                     | required     |
| `skt-gateway` | SKT Gateway       | `https://gateway.skt-ai-labs.example/v1`                    | `auto`                                       | required     |

Notes verified in code:

- Base URLs are normalised: trailing `/` and a trailing `/v1` are stripped, so
  both `https://api.openai.com` and `https://api.openai.com/v1` work.
- `custom` has **no safe default model** — `sanitizeConfig` keeps whatever you
  set and the picker requires an explicit one.
- `llamacpp` is the fully local path: `trayambak serve` starts a llama.cpp
  server (auto-downloads the binary if needed, `TRAYAMBAK_LLAMACPP_BIN`
  overrides it) and `trayambak download <org/model> [file.gguf] [--output <path>]`
  fetches a GGUF from Hugging Face and stores it as `modelPath`.
- `llamacpp` is the one id with **no entry in the per-provider default maps**
  in `sanitizeConfig`, so an unset `baseUrl`/`model` falls through to the global
  `DEFAULTS` (`https://integrate.api.nvidia.com` /
  `nvidia/nemotron-3-super-120b-a12b`). In practice point `baseUrl` at your
  server — `trayambak serve` prints
  `trayambak config set baseUrl http://localhost:<port>` — and set a GGUF `model`.
- Static fallback model lists are used whenever the live `/v1/models` fetch
  fails or the key is missing (e.g. the 8 `nvidia/…` ids in
  `commands/run.ts`) — so the picker never dies on a network blip.

## Switching providers

### In the REPL

```
/provider     # backend → key → live model list → model (direct switch when a key is saved)
/models       # list models for the active provider
/model        # show the current model / pick from the provider
```

### From the shell

```sh
# flags (highest precedence)
trayambak --provider anthropic --model claude-3-5-sonnet-latest --base-url https://api.anthropic.com

# environment (beats the config file)
set TRAYAMBAK_PROVIDER=anthropic
set TRAYAMBAK_API_KEY=sk-ant-...

# config file (persists)
trayambak config set provider anthropic
trayambak config set apiKey sk-ant-...
trayambak config set model claude-3-5-sonnet-latest
```

Precedence is always **defaults < config file < `TRAYAMBAK_*` env < CLI flags**
(`loadConfig()` in `apps/runtime/src/config.ts`).

## Where the key comes from

1. `TRAYAMBAK_API_KEY` environment variable (wins over the file).
2. `apiKey` in `config.json`.
3. Per-backend key store: `config.providers[]` — the TUI's `/provider` flow
   saves a key **per backend** (up to 20 entries) so switching back and forth
   never wipes a saved key. `activeProviderId` records the active entry.
4. `trayambak login --with-api-key <key>` writes
   `~/.trayambak/credentials.json` (0600); `trayambak login status` reports
   whether the file and/or the env var is present.

Keys are **never printed** by the pickers, and they are cleaned at every load
(see below).

### Key hygiene — `cleanApiKey`

Pasted keys frequently carry an env-var prefix that makes every request 401.
`cleanApiKey()` strips these at load (and again when `/provider` saves one):

| Pasted form                   | Stored as          |
| ----------------------------- | ------------------ |
| `NVAPI_KEY nvapi-…`           | `nvapi-…`          |
| `Bearer sk-…` / `bearer sk-…` | `sk-…`             |
| `HF_TOKEN=hf_…`, `API_KEY=…`  | `hf_…`             |
| `"sk-…"` (quoted)             | `sk-…`             |
| `hf_…`                        | kept as-is (valid) |

### Honest key check — `verifyProviderKey`

`verifyProviderKey(providerId, baseUrl, apiKey, model)` performs **one
minimal 1-token chat ping** against the real chat endpoint (not a model-list
call), because model listing can succeed while chat 401s — e.g. a read-only
Hugging Face token. Anthropic is checked against `/v1/messages`, Google
against `:generateContent`, everyone else against `/v1/chat/completions`
with `max_tokens: 1`. Failures return a human hint, e.g.:

- NVIDIA 401 → _use a bare `nvapi-…` key (no `NVAPI_KEY ` prefix) from build.nvidia.com_
- Ollama unreachable → _is `ollama serve` running? Default http://localhost:11434_

## Model listing per provider

`listModelNames()` (`apps/cli/src/commands/run.ts`) adapts to each backend:

| Provider                                                                 | Request                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| OpenAI-compatible (nvidia, nvidia-nim, openai, xai, huggingface, custom) | `GET <base>/v1/models` + `Authorization: Bearer <key>`                  |
| `anthropic`                                                              | `GET <base>/v1/models` + `x-api-key` + `anthropic-version: 2023-06-01`  |
| `ollama`                                                                 | `GET <base>/api/tags` (Ollama-native list)                              |
| `google`                                                                 | `GET <base>/models?key=<key>` (the base URL already contains `/v1beta`) |

Fetches time out after 10s and fall back to the static list.

Successful live lists are cached in `config.modelCache` (per provider id, at
most 20 backends × 150 ids) and shown when the endpoint is unreachable.

## Sampling & runtime knobs that follow the provider

```sh
trayambak config set temperature 0.2      # clamped 0..2
trayambak config set maxTokens 8192       # clamped 1..1_000_000
trayambak config set contextWindow 128000 # drives proactive compaction
trayambak config set reasoningEffort high # low|medium|high|xhigh|max
```

Equivalent env vars: `TRAYAMBAK_TEMPERATURE`, `TRAYAMBAK_TOP_P`,
`TRAYAMBAK_MAX_TOKENS`, `TRAYAMBAK_CONTEXT_WINDOW`, `TRAYAMBAK_TIMEOUT_MS`,
`TRAYAMBAK_REASONING_EFFORT`.

## Fully local (no key, no network)

```sh
trayambak download TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF   # saves GGUF + sets modelPath
trayambak serve --port 8080                                  # llama.cpp server (GPU layers auto-detected)
trayambak --provider llamacpp --model /path/to/model.gguf
```

- `TRAYAMBAK_LLAMACPP_BIN` points at a prebuilt `llama-server`; otherwise
  `trayambak serve` tries to download one.
- Server logs go to `~/.trayambak/logs/llama-server.log`.
- Tuning: `TRAYAMBAK_CTX_SIZE` (16384), `TRAYAMBAK_BATCH_SIZE` (256),
  `TRAYAMBAK_UBATCH_SIZE` (128), `TRAYAMBAK_GPU_LAYERS` (auto: `-1` when a
  GPU is detected, `0` otherwise).
- Ollama needs no download at all: `ollama serve` + provider `ollama`.

## Related

- [Getting started](getting-started.md) — config precedence and env vars.
- [Security](security.md) — key storage and what is sent where.
- [Troubleshooting](troubleshooting.md) — 401/timeout/`ollama` diagnosis.

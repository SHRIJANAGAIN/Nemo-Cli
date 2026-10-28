# Providers

Nemo talks to **5 backends** through one config surface — NVIDIA (hosted) plus
fully local runtimes. The list is the `provider` enum in
`apps/runtime/src/config.ts` and `config.schema.json`; per-backend defaults
come from `PROVIDER_CATALOG` in `packages/provider/src/catalog.ts`.

## The 5 backends

| Provider id   | Label             | Default base URL                                            | Default model                                       | Key          |
| ------------- | ----------------- | ----------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `nvidia`      | NVIDIA            | `https://integrate.api.nvidia.com`                          | `nvidia/nemotron-3-super-120b-a12b`                 | required     |
| `nvidia-nim`  | NVIDIA NIM        | `https://integrate.api.nvidia.com`                          | `nvidia/nemotron-3-super-120b-a12b`                 | required     |
| `ollama`      | Ollama            | `http://localhost:11434`                                    | `llama3.1`                                          | none (local) |
| `custom`      | Custom endpoint   | `http://localhost:8080`                                     | _(none — you must set one)_                         | optional     |
| `llamacpp`    | llama.cpp (local) | _no per-provider default — use your `nemo serve` port_ | _no per-provider default — set your GGUF id_        | none (local) |

Notes verified in code:

- Base URLs are normalised: trailing `/` and a trailing `/v1` are stripped, so
  both `https://integrate.api.nvidia.com` and `https://integrate.api.nvidia.com/v1`
  work.
- `custom` has **no safe default model** — `sanitizeConfig` keeps whatever you
  set and the picker requires an explicit one.
- `llamacpp` is the fully local path: `nemo serve` starts a llama.cpp
  server (auto-downloads the binary if needed, `NEMO_LLAMACPP_BIN`
  overrides it) and `nemo download <org/model> [file.gguf] [--output <path>]`
  fetches a GGUF from Hugging Face and stores it as `modelPath`.
- `llamacpp` is the one id with **no entry in the per-provider default maps**
  in `sanitizeConfig`, so an unset `baseUrl`/`model` falls through to the global
  `DEFAULTS` (`https://integrate.api.nvidia.com` /
  `nvidia/nemotron-3-super-120b-a12b`). In practice point `baseUrl` at your
  server — `nemo serve` prints
  `nemo config set baseUrl http://localhost:<port>` — and set a GGUF `model`.
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
nemo --provider nvidia --model nvidia/nemotron-3-super-120b-a12b

# environment (beats the config file)
set NEMO_PROVIDER=nvidia
set NEMO_API_KEY=nvapi-...

# config file (persists)
nemo config set provider nvidia
nemo config set apiKey nvapi-...
nemo config set model nvidia/nemotron-3-super-120b-a12b
```

Precedence is always **defaults < config file < `NEMO_*` env < CLI flags**
(`loadConfig()` in `apps/runtime/src/config.ts`).

## Where the key comes from

1. `NEMO_API_KEY` environment variable (wins over the file).
2. `apiKey` in `config.json`.
3. Per-backend key store: `config.providers[]` — the TUI's `/provider` flow
   saves a key **per backend** (up to 20 entries) so switching back and forth
   never wipes a saved key. `activeProviderId` records the active entry.
4. `nemo login --with-api-key <key>` writes
   `~/.nemo/credentials.json` (0600); `nemo login status` reports
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
| `API_KEY=…` / `HF_TOKEN=…`    | the value          |
| `"nvapi-…"` (quoted)          | `nvapi-…`          |
| `nvapi-…`                     | kept as-is (valid) |

### Honest key check — `verifyProviderKey`

`verifyProviderKey(providerId, baseUrl, apiKey, model)` performs **one
minimal 1-token chat ping** against the real chat endpoint (not a model-list
call), because model listing can succeed while chat 401s. Every backend is
checked against `/v1/chat/completions` with `max_tokens: 1`. Failures return a
human hint, e.g.:

- NVIDIA 401 → _use a bare `nvapi-…` key (no `NVAPI_KEY ` prefix) from build.nvidia.com_
- Ollama unreachable → _is `ollama serve` running? Default http://localhost:11434_

## Model listing per provider

`listModelNames()` (`apps/cli/src/commands/run.ts`) adapts to each backend:

| Provider                                                                 | Request                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible (nvidia, nvidia-nim, custom, llamacpp)                | `GET <base>/v1/models` + `Authorization: Bearer <key>`                                                                 |
| `ollama`                                                                 | `GET <base>/api/tags` (Ollama-native list)                                                                             |

Fetches time out after 10s and fall back to the static list.

Successful live lists are cached in `config.modelCache` (per provider id, at
most 150 ids) and shown when the endpoint is unreachable.

## Sampling & runtime knobs that follow the provider

```sh
nemo config set temperature 0.2      # clamped 0..2
nemo config set maxTokens 8192       # clamped 1..1_000_000
nemo config set contextWindow 128000 # drives proactive compaction
nemo config set reasoningEffort high # low|medium|high|xhigh|max
```

Equivalent env vars: `NEMO_TEMPERATURE`, `NEMO_TOP_P`,
`NEMO_MAX_TOKENS`, `NEMO_CONTEXT_WINDOW`, `NEMO_TIMEOUT_MS`,
`NEMO_REASONING_EFFORT`.

## Fully local (no key, no network)

```sh
nemo download TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF   # saves GGUF + sets modelPath
nemo serve --port 8080                                  # llama.cpp server (GPU layers auto-detected)
nemo --provider llamacpp --model /path/to/model.gguf
```

- `NEMO_LLAMACPP_BIN` points at a prebuilt `llama-server`; otherwise
  `nemo serve` tries to download one.
- Server logs go to `~/.nemo/logs/llama-server.log`.
- Tuning: `NEMO_CTX_SIZE` (16384), `NEMO_BATCH_SIZE` (256),
  `NEMO_UBATCH_SIZE` (128), `NEMO_GPU_LAYERS` (auto: `-1` when a
  GPU is detected, `0` otherwise).
- Ollama needs no download at all: `ollama serve` + provider `ollama`.

## Related

- [Getting started](getting-started.md) — config precedence and env vars.
- [Security](security.md) — key storage and what is sent where.
- [Troubleshooting](troubleshooting.md) — 401/timeout/`ollama` diagnosis.

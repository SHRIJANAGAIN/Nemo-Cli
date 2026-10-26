# bin/

This directory mixes two very different kinds of files:

## Nemo shims (committed to git)

| File            | Purpose                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nemo.cmd` | Windows CMD shim: locates the project root (`NEMO_HOME` or walk-up), **rebuilds when `dist/` is missing or stale** (via `scripts/check-dist.mjs`), then runs `node dist/apps/cli/src/index.js`. |
| `nemo-code.cmd`       | Same shim, exports `NEMO_BIN_NAME=nemo` so help text shows `nemo`.                                                                                                                                |

Both are covered by CI's Windows smoke test (`.github/workflows/ci.yml`).

## llama.cpp binaries (NOT committed)

Everything else here — `llama-server.exe`, `llama*.dll`, `ggml*.dll`, etc.
(≈44 MB) — is a **local cache of prebuilt llama.cpp Windows binaries**
from [`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp)
releases. They are gitignored (`bin/*.exe`, `bin/*.dll`, …) because they
are large third-party artifacts that are trivially re-downloadable.

How they get (re)populated:

1. **Automatically** — `nemo serve` resolves a usable server binary
   via `apps/runtime/src/llama-cpp-bin.ts`, downloading a release build
   (default tag `b10754`) into this directory when none is found.
2. **Manually** — download a Windows build from the llama.cpp releases
   page and place `llama-server.exe` + its DLLs here, or point Nemo
   at any location with `NEMO_LLAMACPP_BIN`.

Licensing: the llama.cpp binaries are distributed under the terms of their
upstream project (see the LICENSE files shipped with each release; the
OpenMP runtime's license is kept alongside as `LICENSE-LLVM-OpenMP`).
They are **not** covered by Nemo's Apache-2.0 license and are
never published to npm (the tarball only ships `dist/` and `Img/`).

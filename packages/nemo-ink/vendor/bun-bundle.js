/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Runtime stand-in for bun's compile-time feature-flag module `bun:bundle`
 * (aliased in vitest.config.ts). Bun's bundler evaluates `feature(name)`
 * at BUILD time and dead-code-eliminates the losing branch; at test runtime
 * every optional feature branch stays OFF — this keeps the nemo-ink
 * ThemeProvider from loading its auto-theme fs-watcher (feature
 * "AUTO_THEME") during the suite, which is exactly what a non-bundled
 * bun run does too.
 */

export const feature = (name) => {
  void name
  return false
}

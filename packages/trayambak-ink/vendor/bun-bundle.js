/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Runtime stand-in for bun's compile-time feature-flag module `bun:bundle`
 * (aliased in vitest.config.ts). Bun's bundler evaluates `feature(name)`
 * at BUILD time and dead-code-eliminates the losing branch; at test runtime
 * every optional feature branch stays OFF — this keeps the trayambak-ink
 * ThemeProvider from loading its auto-theme fs-watcher (feature
 * "AUTO_THEME") during the suite, which is exactly what a non-bundled
 * bun run does too.
 */

export const feature = (name) => {
  void name
  return false
}

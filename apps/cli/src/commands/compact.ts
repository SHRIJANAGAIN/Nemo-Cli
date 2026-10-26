/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { SessionCompaction, sessionCompaction } from "../session/session-compaction.js"

export interface CompactOptions {
  readonly action: "config" | "estimate" | "run" | "reset"
  readonly maxTokens?: number
  readonly targetTokens?: number
  readonly preserveRecent?: number
  readonly messageCount?: number
  readonly totalTokens?: number
}

export function compactCommand(options: CompactOptions): string {
  const compaction: SessionCompaction = sessionCompaction

  switch (options.action) {
    case "config": {
      const cfg = compaction.getConfig()
      return `Compaction config:\n  maxTokens: ${cfg.maxTokens}\n  targetTokens: ${cfg.targetTokens}\n  preserveRecent: ${cfg.preserveRecent}`
    }
    case "estimate": {
      const mc = options.messageCount ?? 0
      const tt = options.totalTokens ?? 0
      const should = compaction.shouldCompact(mc, tt)
      return `Messages: ${mc}, Tokens: ${tt}\nShould compact: ${should ? "yes" : "no"}`
    }
    case "run": {
      const messages: Array<{ content: string; tokens?: number }> = []
      const result = compaction.compact(messages)
      return `Compaction result: compressed=${result.compressed}, originalTokens=${result.originalTokens}, compressedTokens=${result.compressedTokens}, preserved=${result.preservedMessages}`
    }
    case "reset": {
      return "Compaction state reset"
    }
    default:
      return `Unknown compact action: ${options.action}`
  }
}

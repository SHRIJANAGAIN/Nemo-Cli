/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import React, { type ReactNode, useState } from "react"
import { Box, Text } from "ink"
import { useAppInput } from "./useAppInput.js"
import { isEnter } from "./keys.js"
import { TrayambakLogo } from "./TrayambakLogo.js"
import type { PermissionMode } from "./types.js"

export interface SandboxOption {
  mode: PermissionMode
  label: string
  description: string
}

const OPTIONS: SandboxOption[] = [
  {
    mode: "ask",
    label: "Trust + ask before writes",
    description: "recommended — model works here, approves risky tools",
  },
  {
    mode: "read-only",
    label: "Don't trust — read-only",
    description: "no writes, no edits, safest for strangers' code",
  },
  {
    mode: "auto-approve",
    label: "Trust + auto-approve",
    description: "writes/edits allowed without asking",
  },
  {
    mode: "full-access",
    label: "Trust + full access",
    description: "danger — no approvals needed",
  },
]

export interface SandboxSetupProps {
  cwd: string
  onSelect: (mode: PermissionMode) => void
}

/**
 * First-run sandbox setup (codex TrustDirectory step port): shows the
 * working directory and asks how much freedom the agent gets. The choice
 * becomes the persisted permission mode. Esc keeps the safe default.
 */
export function SandboxSetup({ cwd, onSelect }: SandboxSetupProps): ReactNode {
  const [selected, setSelected] = useState(0)

  useAppInput((input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev - 1 + OPTIONS.length) % OPTIONS.length)
      return
    }
    if (key.downArrow || key.tab) {
      setSelected((prev) => (prev + 1) % OPTIONS.length)
      return
    }
    if (isEnter(input, key)) {
      const opt = OPTIONS[selected]
      if (opt) onSelect(opt.mode)
      return
    }
    const n = parseInt(input, 10)
    if (Number.isFinite(n) && n >= 1 && n <= OPTIONS.length) {
      const opt = OPTIONS[n - 1]
      if (opt) onSelect(opt.mode)
      return
    }
    if (key.escape) {
      onSelect("ask")
    }
  })

  return (
    <Box flexDirection="column" height="100%" paddingX={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <TrayambakLogo />
      </Box>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color="green">
          Trayambak — Sandbox setup
        </Text>
        <Text dimColor>one-time setup, change anytime with /mode</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>{"› "}</Text>
        <Text bold>You are in </Text>
        <Text>{cwd}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor> Do you trust the contents of this directory? Untrusted code can hide</Text>
        <Text dimColor> harmful instructions — pick how freely the agent may act here.</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {OPTIONS.map((opt, idx) => (
          <Box key={opt.mode}>
            <Text color={idx === selected ? "#6cb6f5" : undefined} bold={idx === selected}>
              {idx === selected ? "❯ " : "  "}
            </Text>
            <Text dimColor>{`${idx + 1}. `}</Text>
            <Text color={idx === selected ? "#6cb6f5" : undefined} bold={idx === selected}>
              {opt.label}
            </Text>
            <Text dimColor>{`  ${opt.description}`}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>
        {" enter"} select {" ↑/↓"} browse {" 1-4"} jump {" esc"} recommended default
      </Text>
    </Box>
  )
}
export default SandboxSetup

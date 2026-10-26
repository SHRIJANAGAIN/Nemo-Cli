/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { useState, type ReactNode } from "react"
import { Box, Text, useInput, useStdout } from "ink"
import { useThemeColors } from "./themeColors.js"
import { stringWidth, sliceByWidth } from "./utils/stringWidth.js"
import type { PermissionRequest, PermissionMode } from "./types.js"
import { PERMISSION_MODE_LABELS } from "./types.js"
import { approvalDecisionFor, approvalNavigationFor } from "./approvalKeys.js"
import { Spinner } from "./Spinner.js"
import { Marquee } from "./Marquee.js"
import { g, spinnerFrames } from "./glyphs.js"

function formatArgsSimple(args: Record<string, unknown>, maxLen: number = 200): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return "{}"
  const formatted = entries.map(([key, value]) => {
    let valStr: string
    if (typeof value === "string") {
      valStr = value
    } else if (value === null) {
      valStr = "null"
    } else if (value === undefined) {
      valStr = "undefined"
    } else {
      try {
        valStr = JSON.stringify(value)
      } catch {
        valStr = String(value)
      }
    }
    return `${key}=${valStr}`
  })
  const result = formatted.join(" ")
  // Cluster-safe clip: `.slice` by UTF-16 units stranded a matra from its
  // base at the "…" when the permission line carried Hindi text.
  if (stringWidth(result) > maxLen) {
    return sliceByWidth(result, maxLen - 1) + "…"
  }
  return result
}

export interface PermissionOverlayProps {
  permissionMode: PermissionMode
  pendingRequests: PermissionRequest[]
  /** True while the composer holds a draft: decision keys belong to the
   *  composer then (Ink broadcasts every keypress to all useInput handlers)
   *  — the overlay only shows a hint that Esc clears the draft first. */
  composerHasText?: boolean
  onApprove: (id: string) => void
  onDeny: (id: string) => void
  /** Persist an "allow" rule for this tool+subject to the config. */
  onApproveAlways: (id: string) => void
  /** Add an "allow" rule for this session only. */
  onApproveSession: (id: string) => void
  /** Persist a "deny" rule for this tool+subject to the config. */
  onDenyAlways: (id: string) => void
}

const PERMISSION_MODE_COLORS: Record<PermissionMode, string> = {
  "read-only": "gray",
  plan: "magenta",
  ask: "yellow",
  "auto-approve": "green",
  "full-access": "red",
}

export const PermissionOverlay = ({
  permissionMode,
  pendingRequests,
  composerHasText = false,
  onApprove,
  onDeny,
  onApproveAlways,
  onApproveSession,
  onDenyAlways,
}: PermissionOverlayProps): ReactNode | null => {
  const theme = useThemeColors()
  const { stdout } = useStdout()
  // Cells left for the args row after the pane padding and the " args: " label.
  const argsCols = Math.max(12, (stdout?.columns ?? 80) - 12)

  // Hooks must run unconditionally (Rules of Hooks) — no early returns above.
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Clamp the selection when the queue shrinks (fixes stale-index bugs).
  const safeIdx = Math.min(selectedIdx, Math.max(0, pendingRequests.length - 1))

  useInput((input, key) => {
    if (pendingRequests.length === 0) return
    const current = pendingRequests[safeIdx]
    if (!current) return
    // Esc ALWAYS denies — even with a composer draft. The old early-return
    // on composerHasText swallowed Esc too, leaving Deny unreachable until
    // the user discovered "Esc clears draft (twice)" (looked hung).
    if (key.escape) {
      onDeny(current.id)
      return
    }
    // The composer has a draft → y/n/Enter/arrows are typing, not
    // decisions (PromptInput reports the flag via onComposerHasTextChange
    // and keeps every other key for itself while the buffer is empty).
    if (composerHasText) return
    const decision = approvalDecisionFor(input, key, composerHasText)
    if (decision) {
      switch (decision) {
        case "approve":
          onApprove(current.id)
          return
        case "deny":
          onDeny(current.id)
          return
        case "approveAlways":
          onApproveAlways(current.id)
          return
        case "approveSession":
          onApproveSession(current.id)
          return
        case "denyAlways":
          onDenyAlways(current.id)
          return
        default:
          return
      }
    }
    const nav = approvalNavigationFor(input, key)
    if (nav !== 0) {
      setSelectedIdx((prev) => Math.max(0, Math.min(pendingRequests.length - 1, prev + nav)))
      return
    }
  })

  if (pendingRequests.length === 0) {
    return null
  }

  const modeLabel = PERMISSION_MODE_LABELS[permissionMode]
  const modeColor = PERMISSION_MODE_COLORS[permissionMode]

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      marginTop={1}
      width="100%"
      backgroundColor={theme.backgroundElement}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            {/* Attention animation: the overlay is a WAITING state (the turn
                is parked on the user) — a rotating half-circle in the
                mode's own colour keeps it visibly alive instead of a frozen
                dialog header. Label text unchanged (oracles key on it). */}
            <Spinner frames={spinnerFrames().slice(0, 4)} color={modeColor}>
              Permission Required
            </Spinner>
            <Text dimColor> (mode: {modeLabel})</Text>
          </Box>
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={1} paddingBottom={1}>
        {pendingRequests.map((req, idx) => {
          const isSelected = idx === safeIdx
          return (
            <Box key={req.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text dimColor> tool: </Text>
                <Text bold color={theme.accent}>
                  {req.tool}
                </Text>
                {req.forceAsk && (
                  <Text bold color={theme.error}>
                    {" "}
                    {g("warn")} sensitive — always asks
                  </Text>
                )}
              </Box>
              <Box>
                <Text dimColor> reason: </Text>
                <Text color={theme.warning}>{req.reason}</Text>
              </Box>
              {req.args && Object.keys(req.args).length > 0 && (
                <Box flexDirection="row" flexWrap="nowrap">
                  <Text dimColor> args: </Text>
                  {isSelected ? (
                    /* One row, scrolling — the old wrapping Text pushed a long
                       `command=` payload over three lines and the [y]/[n] hints
                       off the bottom of the pane, which is where a permission
                       dialog looks hung to the user. Text that fits never
                       scrolls (see Marquee). */
                    <Marquee text={formatArgsSimple(req.args)} width={argsCols} dimColor />
                  ) : (
                    <Text dimColor>{formatArgsSimple(req.args, argsCols)}</Text>
                  )}
                </Box>
              )}
              {isSelected && (
                <Box marginTop={1} flexDirection="column">
                  {composerHasText ? (
                    <Text dimColor>{"  draft in composer — Esc clears it (twice), then these keys answer:"}</Text>
                  ) : (
                    <>
                      <Box>
                        <Text color="green" bold>
                          {"[y] Allow once   "}
                        </Text>
                        <Text color="green" bold>
                          {"[a] Always allow   "}
                        </Text>
                        <Text color="green" bold>
                          {"[s] Allow for session"}
                        </Text>
                      </Box>
                      <Box>
                        <Text color="red" bold>
                          {"[n] Deny once   "}
                        </Text>
                        <Text color="red" bold>
                          {"[x] Never allow (save deny rule)"}
                        </Text>
                      </Box>
                      <Box>
                        <Text color="green" bold>
                          {"  [enter] Allow once   "}
                        </Text>
                        <Text color="red" bold>
                          {"[esc] Deny   "}
                        </Text>
                        <Text color={theme.accent} bold>
                          {"[↑/↓] switch request"}
                        </Text>
                      </Box>
                    </>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default PermissionOverlay

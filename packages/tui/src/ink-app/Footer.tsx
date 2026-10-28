/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode, useMemo } from "react"
import { Box, Text, useStdout } from "ink"
import { Spinner } from "./Spinner.js"
import type { StatusBarInfo, BackgroundSubagentState } from "./types.js"
import { PERMISSION_MODE_LABELS, STATUS_LABELS, formatSubagentToolcalls } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { contextUsage } from "./sidebar-data.js"
import { g, spinnerFrames } from "./glyphs.js"
import { fitFooter, versionChipText, SEGMENT_GAP, type FooterSegment } from "./footer-fit.js"
import { glyphSet } from "./glyphs.js"
import { orbitPaint, orbitSettled, RIBBON_TICK_MS } from "./thinking-ribbon.js"
import { cycleIndex, motionTravels } from "./animations.js"
import { useBorderPulse } from "./use-border-pulse.js"
import { useAnimationClock, useMotionLevel, useTicker } from "./use-animation-clock.js"
import { idleAnimEnabled, useIdleBreathe, idleSilver, idleGlyph } from "./use-idle-breathe.js"
import { formatElapsed } from "./duration-text.js"

/** Slow enough to read as "still waiting", fast enough to prove the app is
 *  alive while nothing else on screen moves. */
const OFFLINE_PULSE_MS = 1200

export interface FooterProps {
  info: StatusBarInfo
  backgroundSubagents?: Map<string, BackgroundSubagentState>
  subagentTabs?: BackgroundSubagentState[]
  /** Breathe while idle even without `NEMO_IDLE_ANIM`. The home screen
   *  sets this because its frame already repaints for the clock/starfield, so
   *  the idle-silence contract (transcript view) is not the active one. */
  idleBreathe?: boolean
}

function subagentStatusIcon(status: BackgroundSubagentState["status"]): string {
  if (status === "completed") return g("dot")
  if (status === "cancelled") return g("ring")
  if (status === "error") return g("fail")
  return g("spinnerDot")
}

function subagentStatusColor(theme: ReturnType<typeof useThemeColors>, status: BackgroundSubagentState["status"]) {
  if (status === "completed") return theme.accent
  if (status === "cancelled") return theme.textMuted
  if (status === "error") return theme.error
  return theme.warning
}

function subagentLabel(item: BackgroundSubagentState): string {
  const elapsed = Math.floor((Date.now() - item.startedAt) / 1000)
  const label = `${item.name} (${elapsed}s)`
  if (item.result) {
    const toolcallSuffix = item.toolcalls ? ` · ${formatSubagentToolcalls(item.toolcalls)}` : ""
    return `${label}${toolcallSuffix} · completed`
  }
  return `${label} · running`
}

/** Key hints: REMOVED from the footer on request — the strip competed with
 *  the operational readout for the same columns, and every one of those keys
 *  is still discoverable through `ctrl+k` (which key) and the command
 *  palette. Passing no variants makes fitFooter skip the hint segment
 *  entirely, so the space goes back to model + counts. */
function hintVariants(): string[] {
  return []
}

export const Footer = ({ info, backgroundSubagents, subagentTabs, idleBreathe = false }: FooterProps): ReactNode => {
  const theme = useThemeColors()
  // The orb ribbon rides the shared frame clock: it only subscribes while a
  // turn is in flight, so an idle footer still writes ZERO bytes (the
  // idle-silence contract the Windows scrollbar and native drag depend on),
  // and its repaint lands in the same commit as the spinner and the tool boxes
  // instead of forcing a partial frame of its own twice a second.
  const turnActive = info.status === "thinking" || info.status === "running"
  // The parked phase, rendered as a measurement rather than as a spinner. The
  // wait comes off `useTicker`, not `useAnimationClock`: how long the socket has
  // been dead IS a real quantity, and freezing it at `/motion off` would put a
  // stale "3s" over an outage that has run for two minutes. The dot keeps a slow
  // colour pulse (decoration, so it is gated: `off` pins it to the full-strength
  // frame, never to a dim one that reads as "less important"), and its GLYPH
  // never changes — a fixed ring is the resting frame.
  const offline = info.status === "offline"
  const waitTick = useTicker(1000, offline)
  // `waitTick` is only the scheduler; the number itself comes from the event
  // timestamp, so a remount mid-outage (the resize repaint) cannot restart it.
  void waitTick
  const waitedMs = offline && info.networkLostAt !== undefined ? Math.max(0, Date.now() - info.networkLostAt) : 0
  const offlinePulse = useAnimationClock(OFFLINE_PULSE_MS, offline)
  const orbFrame = useAnimationClock(RIBBON_TICK_MS, turnActive)
  // The comet head travels, so under `reduced`/`off` the cluster shows its
  // resting paint: same two braille cells, one uniform shade, no white head
  // parked mid-orbit. The footer keeps its slow colour breathe, which is
  // exactly what those levels are allowed to keep.
  const motion = useMotionLevel()
  const orbAscii = glyphSet() === "ascii"
  const orbPaintRow = useMemo(
    () => (turnActive ? (motionTravels(motion) ? orbitPaint(orbFrame, orbAscii) : orbitSettled(orbAscii)) : []),
    [turnActive, orbFrame, orbAscii, motion],
  )
  const orbs = turnActive ? { frame: orbFrame, ascii: glyphSet() === "ascii" } : undefined
  // Opt-in idle breathe (NEMO_IDLE_ANIM=1), auto-on for the home screen:
  // silver drift while no turn runs. Off the home screen no flag => active=false
  // => useIdleBreathe installs NO timer, so the transcript keeps its
  // zero-byte idle contract.
  const idleAnim = (idleBreathe || idleAnimEnabled()) && !turnActive && !offline && info.isStreaming !== true
  const breathe = useIdleBreathe(idleAnim)
  // Read columns directly at render time — deliberately NOT useWindowSize():
  // a columns subscription re-renders the WHOLE tree after a width resize,
  // which paints a second full frame right behind resize-guard's
  // blank+repaint (its contract: exactly one live frame — its smoke counts
  // Welcome frames). Footer re-fits on whatever render comes next instead
  // (same pattern as ModelPicker's stdout.columns read).
  const { stdout } = useStdout()
  const columns = stdout?.columns || 80
  const modeLabel = PERMISSION_MODE_LABELS[info.permissionMode]
  const tokenCount = info.tokenCount ?? 0
  const tokenColor = tokenCount >= 3000 ? theme.error : tokenCount >= 1000 ? theme.warning : theme.success
  const bgCount = info.backgroundCount ?? 0
  const queuedCount = info.queuedCount ?? 0

  // Shrijan's context indicator: current tokens as a % of the model's window.
  const usage = contextUsage(tokenCount, info.contextWindow)
  const ctxColor =
    usage.percent === null
      ? theme.info
      : usage.percent >= 90
        ? theme.error
        : usage.percent >= 70
          ? theme.warning
          : theme.info

  const bgRunning = backgroundSubagents
    ? Array.from(backgroundSubagents.values()).some((j) => j.status === "running")
    : false
  const statusColor =
    info.status === "error"
      ? theme.error
      : offline
        ? theme.warning
        : info.status === "running"
          ? theme.warning
          : info.status === "thinking"
            ? theme.info
            : theme.success

  const activeSubagents = subagentTabs ? subagentTabs.filter((s) => s.status === "running" || s.status === "error") : []

  // Pure fit against real terminal columns: core always kept, optionals
  // added while they fit, model ellipsized rather than wrapped, hints
  // shortened then dropped. Nothing in here can emit a line wider than
  // `fit.inner` except absurd sub-minimum terminals (truncate net below).
  const fit = fitFooter({
    columns,
    model: info.model,
    statusText: offline ? `${STATUS_LABELS.offline} ${formatElapsed(waitedMs)}` : STATUS_LABELS[info.status],
    modeText: `Mode: ${modeLabel}`,
    tokenText: `Tokens: ${tokenCount}`,
    ctxText: usage.percent !== null ? `ctx ${usage.percent}%` : undefined,
    orbs,
    bgText: bgCount > 0 ? `BG: ${bgCount}` : undefined,
    // The count alone reports a state the user cannot act on: `/queue` lists,
    // drops and clears it, and the queued prompts themselves scroll out of the
    // transcript as system notices. Name the command on the chip.
    queueText: queuedCount > 0 ? `>> Queue: ${queuedCount} (/queue)` : undefined,
    scrollText: info.scrollDepth ? `↑ ${info.scrollDepth}` : undefined,
    versionText: info.version ? versionChipText(info.version) : undefined,
    spinner: bgRunning || undefined,
    bgHint: bgCount > 0 ? "ctrl+b bg" : undefined,
    taskHint: info.taskHint,
    subagentLabels: activeSubagents.map((s) => `${subagentStatusIcon(s.status)} ${subagentLabel(s)}`),
    hintVariants: hintVariants(),
  })

  const renderSegment = (seg: FooterSegment, index: number): ReactNode => {
    const separator = index > 0 ? <Text>{" ".repeat(SEGMENT_GAP)}</Text> : null
    let content: ReactNode
    switch (true) {
      case seg.id === "status": {
        // seg.text is "<dot> <label>" — the label always takes the status
        // color (identical widths: 1 + 1 + label). The old hardcoded green
        // dot claimed all-clear while the label said error/thinking. With
        // idle breathe ON the dot drifts silver; the label stays put so the
        // row never shouts.
        const label = seg.text.slice(2)
        const dotColor = idleAnim ? idleSilver(breathe) : statusColor
        // Idle: the mark twinkles glyphs too, so the breathe is still visible
        // where colour is stripped (and it keeps the fit width at 1 cell).
        // Parked on a dead socket the mark is a fixed ring — a shape that
        // twinks would compete with the wait time it sits next to.
        const dotGlyph = idleAnim ? idleGlyph(breathe, glyphSet() === "ascii") : offline ? g("ring") : g("dot")
        // Only the brightness moves while parked, so `/motion off` pins the tick
        // to 0 and the ring holds at full strength instead of a dim "less
        // important". Colour alone is invisible where SGR is dropped, which is
        // why the label carries the same fact in words.
        const dotDim = offline && cycleIndex(offlinePulse, 2) === 1
        content = (
          <>
            <Text color={dotColor} dimColor={dotDim}>
              {`${dotGlyph} `}
            </Text>
            <Text color={statusColor}>{label}</Text>
          </>
        )
        break
      }
      case seg.id === "mode":
        content = <Text color={theme.primary}>{seg.text}</Text>
        break
      case seg.id === "tokens":
        content = <Text color={tokenColor}>{seg.text}</Text>
        break
      case seg.id === "ctx":
        content = <Text color={ctxColor}>{seg.text}</Text>
        break
      case seg.id === "bg":
        content = <Text color={theme.warning}>{seg.text}</Text>
        break
      case seg.id === "queue":
        content = <Text color={theme.info}>{seg.text}</Text>
        break
      case seg.id === "scroll":
        content = <Text color={theme.warning}>{seg.text}</Text>
        break
      case seg.id === "version":
        content = <Text dimColor>{seg.text}</Text>
        break
      case seg.id === "orbs":
        // One cell per orb, each on its own silver step — the fit measured
        // this row's width, so painting it wider would overflow the frame.
        content = (
          <>
            {orbPaintRow.map((orb, i) => (
              <Text key={i} color={orb.color} bold>
                {orb.glyph}
              </Text>
            ))}
          </>
        )
        break
      case seg.id === "spinner":
        content = <Spinner color={theme.warning} />
        break
      case seg.id === "bg-hint":
        content = <Text dimColor>{seg.text}</Text>
        break
      case seg.id === "task-hint":
        content = <Text color={theme.success}>{seg.text}</Text>
        break
      case seg.id === "hints":
        content = <Text dimColor>{seg.text}</Text>
        break
      case seg.id.startsWith("chip:"): {
        const idx = Number(seg.id.slice(5))
        const item = activeSubagents[idx]
        const running = item?.status === "running"
        const icon = seg.text[0] ?? "○"
        const rest = seg.text.slice(1)
        content = running ? (
          <>
            <Spinner
              color={item ? subagentStatusColor(theme, item.status) : theme.warning}
              frames={spinnerFrames()}
              cycleColors
            />
            <Text color={theme.textMuted}>{rest}</Text>
          </>
        ) : (
          <>
            <Text color={item ? subagentStatusColor(theme, item.status) : theme.textMuted}>{icon}</Text>
            <Text color={theme.textMuted}>{rest}</Text>
          </>
        )
        break
      }
      default:
        content = <Text dimColor>{seg.text}</Text>
    }
    return (
      <React.Fragment key={seg.id}>
        {separator}
        {content}
      </React.Fragment>
    )
  }

  // "Ye section bhi rounded" + "upar bhi ek line add": the status row is a
  // COMPLETE rounded panel — ╭──╮ on top, │ walls, ╰──╯ bottom (which
  // REPLACES the old plain --- rule). That's exactly the "footer(~3)" rows
  // MessageList's rowBudget already budgets (root border 2 + footer 3 +
  // composer 2 ≈ 7) — so the frame still fills the viewport to the ╰ cap
  // with no overflow. Idle keeps the rule's always-blue azure (theme
  // switches must not dim it); while a turn runs the border animates with
  // the tool boxes ("that animation also [on] the model box"). Opt-in idle
  // breathe (NEMO_IDLE_ANIM=1) drifts the border silver instead of
  // azure — flag off keeps azure and zero idle bytes.
  const animating = info.status === "running" || info.status === "thinking" || info.isStreaming === true
  const pulse = useBorderPulse(animating, [theme.primary, theme.accent, theme.warning, theme.success], theme.border)
  const borderColor = animating ? pulse.color : idleAnim ? idleSilver(breathe) : "#2EA6FF"

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={borderColor}
      backgroundColor={theme.background}
    >
      {/* The row paints the theme background across its FULL width: Ink emits
          no SGR for text-less boxes, so the `<Box flexGrow={1} />` spacer used
          to render in the raw terminal backdrop (pure black) while every text
          cell beside it carried the theme background — a black shadow stripe
          across the bar on any non-black terminal. The gap is therefore an
          exact run of painted spaces (fit reserves every column), not flex. */}
      <Box width="100%" paddingX={1} backgroundColor={theme.background}>
        {/* truncate is the last-resort net: fit math keeps us inside the
            box, this guarantees no mid-word split even at sub-minimum
            widths where core alone overflows. */}
        <Text color={theme.textMuted} wrap="truncate">
          {fit.model}
        </Text>
        <Box flexGrow={1} />
        <Box flexDirection="row">{fit.segments.map((seg, index) => renderSegment(seg, index))}</Box>
      </Box>
    </Box>
  )
}

export default Footer

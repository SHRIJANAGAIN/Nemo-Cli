/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { useEffect, useRef, useState, type ReactNode } from "react"
import { Box, Text, render, useStdout } from "ink"
import {
  loadSessions,
  createSession,
  appendConversation,
  updateConversationToolResult,
  endSession,
  deleteSession,
  renameSession,
  DEFAULT_SESSION_NAME,
  type SessionEntry,
} from "../../../../skt/9-session/session.js"
import { Agent } from "../../../../apps/runtime/src/agent/agent.js"
import type { Agent as AgentType } from "../../../../apps/runtime/src/agent/agent.js"
import type { TrayambakConfig } from "../../../../apps/runtime/src/config.js"
import type { TaggedAgentEvent, AgentEventSink } from "../../../protocol/src/index.js"
import {
  evaluatePermission,
  permissionSubject,
  addSessionPermissionRule,
  getSessionPermissionRules,
  DEFAULT_PERMISSIONS,
  type PermissionConfig,
} from "../../../protocol/src/index.js"
import { WelcomeScreen } from "./WelcomeScreen.js"
import { MessageList } from "./MessageList.js"
import { PromptInput } from "./PromptInput.js"
import { Footer } from "./Footer.js"
import { Spinner } from "./Spinner.js"
import { PermissionOverlay } from "./PermissionOverlay.js"
import { SessionPicker } from "./SessionPicker.js"
import { SubagentPanel } from "./SubagentPanel.js"
import { AgentPicker } from "./AgentPicker.js"
import { WhichKey, type WhichKeyAction } from "./WhichKey.js"
import { cycleMode, enterMode, exitMode, formatModeStack, isPermissionMode } from "./mode-stack.js"
import { CTRL_C_EXIT_WINDOW_MS, resolveCtrlCPress } from "./keys.js"
import { formatKeymapMessage } from "../keybindings.js"
import {
  convertToAgentMessages,
  createAgentConfig,
  debugInputLog,
  enableBracketedPaste,
  useTerminalRows,
  type TrayambakAppProps,
} from "./app-bootstrap.js"
import { createSessionPickerActions } from "./session-picker-actions.js"
import { runDevmode } from "./devmode-command.js"
import { runMcp } from "./mcp-command.js"
export { type TrayambakAppProps } from "./app-bootstrap.js"
import { useAppInput } from "./useAppInput.js"
import { onMouseScroll } from "./mouse-input.js"
import { pageScrollOffset, scrollOffsetAfterGrowth, wheelScrollOffset } from "./scroll-math.js"
import { useBorderPulse } from "./use-border-pulse.js"
import { useThemeColors } from "./themeColors.js"
import { ThemePicker } from "./ThemePicker.js"
import { CommandPalette } from "./CommandPalette.js"
import type { PaletteEntry } from "./command-palette.js"
import { ModelPicker } from "./ModelPicker.js"
import { ProviderPicker } from "./ProviderPicker.js"
import { SplashScreen } from "./SplashScreen.js"
import { BootCine } from "./BootCine.js"
import { SandboxSetup } from "./SandboxSetup.js"
import { pushRecent, toggleFavorite } from "./model-picker.js"
import { Sidebar, shouldShowSidebar } from "./Sidebar.js"
import type { SidebarTodo } from "./sidebar-data.js"
import { saveConfig, loadConfig, cleanApiKey } from "../../../../apps/runtime/src/config.js"
import {
  serverActivateLicenseKey,
  serverCanUsePentest,
  serverMintTrial,
  serverVerifyLicenseKey,
} from "../../../../apps/runtime/src/license.js"
import {
  githubLoginStatus,
  githubLogout,
  openBrowser,
  pollGithubLogin,
  readGithubIssue,
  startGithubLogin,
} from "../../../../apps/runtime/src/github-auth.js"
import { checkForUpdate } from "../../../../apps/runtime/src/update/auto-update.js"
import { enhancePrompt } from "../../../../apps/runtime/src/prompt/enhance-prompt.js"
import { generateChatTitle } from "../../../../apps/runtime/src/prompt/auto-title.js"
import { CheckpointStore, CheckpointTooBigError } from "../../../../apps/runtime/src/checkpoints.js"
import { extractAndStoreMemories, loadMemory } from "../../../../apps/runtime/src/tools/memory/memory.js"
import { buildInitPrompt, buildReviewPrompt } from "../../../../apps/runtime/src/agent/review-init.js"
import { listCronJobs, tickCronJobs } from "../../../../apps/runtime/src/tools/trayambak/cron.js"
import { parseUnifiedDiff, renderDiffFiles } from "../../../../apps/runtime/src/tools/text/diff-render.js"
import { execFileSync } from "node:child_process"
import { compactMessages, policyFromConfig } from "../../../../apps/runtime/src/compaction.js"
import { notifyPermissionRequest, notifyBalloon } from "../notifications.js"
import {
  setThemeByName as applyTrayambakTheme,
  listThemes as getTrayambakThemes,
  getTheme as getLiveTheme,
  type Theme as TrayambakTheme,
} from "../ui/theme.js"
import type {
  TrayambakMessage,
  PermissionRequest,
  PermissionMode,
  AppStatus,
  StatusBarInfo,
  QuestionRequest,
  BackgroundSubagentState,
} from "./types.js"
import { SLASH_COMMANDS, formatSubagentTitle } from "./types.js"
import { copyTextToClipboard, formatTranscript } from "./clipboard.js"

import { createSubagentCard, finalizeSubagentCard, applyChildToolEvent, type SubagentRouting } from "./subagent-view.js"
import {
  buildTerminalTitle,
  notifyTerminalActivity,
  setTerminalTitle,
  startTitleAnimation,
  stopTitleAnimation,
} from "./terminal-notify.js"
import { slashCommandService } from "../../../../apps/cli/src/commands/slash-command.js"
import {
  loadPromptCommands,
  defaultPromptCommandDirs,
  expandPromptCommand,
  type PromptCommand,
} from "./prompt-files.js"
import { listAgentProfiles } from "../../../../apps/cli/src/commands/agent.js"
import {
  PROVIDER_CATALOG,
  fetchModelsDetailed,
  getCatalogEntry,
  verifyProviderKey,
} from "../../../provider/src/catalog.js"
import { todoListForSession } from "../../../../apps/cli/src/commands/todo.js"
import { g } from "./glyphs.js"
// Stateless provider/model helpers (extracted from this file for max-file-size).
import {
  fetchWarn,
  providerHostFor,
  providerLabelFor,
  readStoredKey,
  resolveModels,
  themeToPickerOption,
  writeStoredKey,
} from "./provider-model-support.js"

export const TrayambakApp = ({
  config,
  modelName = "trayambak",
  permissionMode: initialMode = "ask",
  onExit,
  initialPrompt,
}: TrayambakAppProps): ReactNode => {
  const theme = useThemeColors()
  const [messages, setMessages] = useState<TrayambakMessage[]>([])
  /** Remount token for MessageList: bumped whenever `messages` is replaced
   *  wholesale (restore / clear / new chat) so Ink resets <Static>'s print
   *  index and the NEW history prints from item 0 (never continuing the
   *  previous session's scrollback). */
  const [staticEpoch, setStaticEpoch] = useState(0)
  /** True once MessageList has a scrollback prefix (see its onHasPrefix
   *  prop): the root frame then drops its TOP border so the evicted
   *  segment's │ walls continue into the frame's — ONE continuous
   *  conversation box, never cut by a mid-transcript ┌────┐ divider. */
  const [hasStaticPrefix, setHasStaticPrefix] = useState(/*initial*/ false)
  /** True while the composer holds a draft — PermissionOverlay stands down
   *  on y/n/Enter then (Ink broadcasts every key to every handler). */
  const [composerHasText, setComposerHasText] = useState(/*initial*/ false)
  const [isLoading, setIsLoading] = useState(/*initial*/ false)
  const [isStreaming, setIsStreaming] = useState(/*initial*/ false)
  const [status, setStatus] = useState<AppStatus>("idle")
  // Boot from the PERSISTED mode when valid: the launcher prop defaults to
  // "ask" and the old code took it blindly, so every restart silently
  // dropped auto-approve/full-access ("IT AUTO SHIFT TO ASK"). The parent
  // CLI feeds the saved user config through, so config.permissions.uiMode
  // is the user's last choice when present.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    isPermissionMode(config?.permissions?.uiMode) ? config.permissions.uiMode : initialMode,
  )
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([])
  // SKT AI LABS-style prompt queue: prompts typed while a turn is running wait in a
  // FIFO and run automatically when the current turn finishes.
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([])
  const queueRef = useRef<string[]>([])
  const isRunningRef = useRef(/*initialValue*/ false)
  const checkpointStoreRef = useRef<CheckpointStore | null>(null)
  /** One-shot flag for the session-scoped oversize transcript notice. */
  const cpTooBigNotedRef = useRef(/*initialValue*/ false)
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null)
  const { stdout } = useStdout()
  // Terminal discipline for the whole app lifetime: the hardware caret is
  // HIDDEN (Ink never positions it — it floated mid-frame/border after
  // every write: "wo blinker show ho raha") and the composer draws its own
  // static block caret (PromptInput `▌`, at the typing position).
  // Mouse reporting is ON for the TUI's LIFETIME (1000+1006, alongside the
  // caret hide below): the wheel then ALWAYS arrives on the mouse-input bus
  // (StdinSanitizer parses it) → scrollBack below → MessageList slides its
  // window IN-APP, which token/caret writes can't yank. The old turn-scoped
  // design left IDLE wheel-ups to native terminal scroll — exactly where a
  // terminal that snaps output back to the live view struck ("scroll karke
  // chhodo to wapas bottom pe snap" — the caret blinks a write every 530ms,
  // same yank as "generation ke dauran ek jagah pe dubara aa jati hai").
  // Trade-off: native wheel / drag-select over the printed <Static> prefix
  // now needs Shift (xterm override) or /copy — and a scrolled frame re-shows
  // those same rows in-app, so nothing becomes unreachable. Cleanup restores
  // wheel + caret to the terminal on unmount.
  useEffect(() => {
    stdout?.write("\x1b[?25l")
    stdout?.write("\x1b[?1000h\x1b[?1006h")
    return () => {
      stdout?.write("\x1b[?1000l\x1b[?1006l")
      stdout?.write("\x1b[?25h")
    }
  }, [stdout])
  const turnActive = isLoading || isStreaming
  /** Wheel offset into history: messages the frame window sits BEHIND the
   *  live end (0 = live). 3 messages per notch (wheelScrollOffset),
   *  clamped to the first message up / 0 down — and ANCHORED while
   *  scrolled (scrollOffsetAfterGrowth below): rows appended behind the
   *  window can't slide the history being read out of frame. */
  const [scrollBack, setScrollBack] = useState(0)
  const scrollLenRef = useRef(messages.length)
  useEffect(() => {
    // Reporting is on for the TUI's lifetime, so the bus delivers wheel
    // notches at idle and mid-turn alike (native terminal scroll never
    // competes with this window).
    return onMouseScroll((dir) => {
      setScrollBack((s) => wheelScrollOffset(dir, s, messages.length))
    })
  }, [messages.length])
  // Anchor: every message appended while scrolled (tool rows land two-per-
  // call mid-turn) is matched by +1 on the offset, so endIdx =
  // length − scrollBack — the exact window the user is reading — never
  // moves toward live ("history hide nahi honi chahiye, pura show hoti
  // rahe"). Live (0) stays live; wholesale replaces reset via staticEpoch.
  useEffect(() => {
    // Capture prev BEFORE the updater runs: the queued updater reads the
    // ref when React flushes it — mutating scrollLenRef on the next line
    // made it see (new, new) → delta 0 → anchor dead → the reading window
    // slid toward live on every append (diag-scroll.mjs pins it: after a
    // mid-turn wheel, S_after must keep endIdx=1, err=0).
    const prev = scrollLenRef.current
    setScrollBack((s) => scrollOffsetAfterGrowth(prev, messages.length, s))
    scrollLenRef.current = messages.length
  }, [messages.length])
  // Snap to live ONLY at submit (runSlash + handleInput's runAgent call):
  // the old turnActive effect yanked mid-turn wheel-ups back to live.
  // The growth anchor above keeps a parked window stable while rows append.
  useEffect(() => {
    setScrollBack(0)
  }, [staticEpoch])
  /** PageUp/PageDown (PromptInput's onHistoryScroll): a 10-message stride
   *  through history — same offset state, same clamps, same growth anchor
   *  as the wheel's 3-notch steps ("easy scrollable": one keypress pages a
   *  long transcript instead of a wheel marathon). */
  const handleHistoryScroll = (dir: "up" | "down"): void => {
    setScrollBack((s) => pageScrollOffset(dir, s, messages.length))
  }
  // The CONVERSATION BOX itself joins the edge-chase while the AI works
  // ("animations dalo UI me"): one outline edge lights up and travels
  // round the ╭╮╰╯ frame — same language as the tool boxes and the footer
  // model panel, but on the biggest box in the UI. dim = primary (NOT the
  // grey theme border) so the box never greys out: it stays brand-blue
  // with a light running round it. Idle → palette[0] = primary, byte-
  // identical to the old solid outline.
  const rootPulse = useBorderPulse(turnActive, [theme.primary, theme.accent, theme.info, theme.success], theme.primary)
  const [waitingCustom, setWaitingCustom] = useState(/*initial*/ false)
  const [tokenCount, setTokenCount] = useState(0)
  const [backgroundSubagents, setBackgroundSubagents] = useState<Map<string, BackgroundSubagentState>>(new Map())
  /* Subagent UI (SKT AI LABS parity): overlay panel, agent picker, transient footer
   * hint, and a derived count for status/notify effects. */
  const [showSubagentPanel, setShowSubagentPanel] = useState(/*initial*/ false)
  const [panelInitialTab, setPanelInitialTab] = useState<"all" | "background">("all")
  const [showAgentPicker, setShowAgentPicker] = useState(/*initial*/ false)
  const [showWhichKey, setShowWhichKey] = useState(/*initial*/ false)
  const [taskHint, setTaskHint] = useState<string | null>(null)
  /** Ctrl+O: tool outputs + compaction summaries render full instead of
   *  preview/collapsed. Drilled to MessageList → MessageRow → tool items. */
  const [expandOutput, setExpandOutput] = useState(/*initial*/ false)
  /** Ctrl-C idle double-press: epoch ms of the arming press + its hint
   *  timer (single Ctrl-C never exits — see resolveCtrlCPress). */
  const lastCtrlCRef = useRef(0)
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** /github login wait guard: blocks stacked ~60s pollers from a
   *  double-fired slash (chooser pick + Enter) — the stale poller wrote a
   *  competing outcome row (blink). While true, re-login parks. */
  const githubLoginBusyRef = useRef(/*initial*/ false)
  const bgRunningCount = Array.from(backgroundSubagents.values()).filter((j) => j.status === "running").length
  /** Boot ALWAYS lands on the first screen — never the session picker.
   *  The old init auto-opened the picker whenever sessions existed without
   *  an active one ("RESET ... SO I CAN GO TO SEE FIRST SCREEN"): any use
   *  at all then hijacked every later launch, and only a factory reset
   *  cleared it. Sessions stay one command away — /sessions, /resume, or
   *  the Ctrl+K q leader action — but nothing opens them by itself. */
  const [showPicker, setShowPicker] = useState(/*initial*/ false)

  const [showThemePicker, setShowThemePicker] = useState(() => !config?.themeName)
  const [showPalette, setShowPalette] = useState(/*initial*/ false)
  const [showModelPicker, setShowModelPicker] = useState(/*initial*/ false)
  const [showProviderPicker, setShowProviderPicker] = useState(/*initial*/ false)
  /** First-run onboarding (codex Welcome → theme → sandbox order): splash
   *  first, then the existing theme picker, then sandbox setup. Returning
   *  users (theme already saved) skip all three. */
  /** First-run derives from the RUNNING config: ink-repl passes
   *  loadConfig() verbatim as the prop, so production semantics are
   *  identical to the old file read — but harnesses that pass an explicit
   *  config (themeName set) no longer depend on a cwd config.json existing
   *  (a reset environment has none, yet must not boot into onboarding).
   *  Falls back to the file when the prop carries no theme. */
  const [isFirstRun] = useState(() => !(config?.themeName ?? loadConfig().themeName))
  const [splashDone, setSplashDone] = useState(/*initial*/ false)
  const [sandboxDone, setSandboxDone] = useState(/*initial*/ false)
  const showSplash = isFirstRun && !splashDone
  /** Boot cinematic for returning users (first-run keeps its own splash):
   *  skipped when a prompt was passed in (never delay real work). */
  const [bootCineDone, setBootCineDone] = useState(/*initial*/ false)
  const showBootCine = !isFirstRun && !bootCineDone && !initialPrompt
  const showSandboxSetup = isFirstRun && splashDone && !showThemePicker && !sandboxDone
  const [showSidebar, setShowSidebar] = useState(/*initial*/ false)
  const [modelFavorites, setModelFavorites] = useState<string[]>(() => loadConfig().modelFavorites ?? [])
  const [modelRecents, setModelRecents] = useState<string[]>(() => loadConfig().modelRecents ?? [])
  const [availableModels, setAvailableModels] = useState<string[] | null>(null)
  const [activeModel, setActiveModel] = useState<string>(() => config?.model ?? loadConfig().model ?? modelName)
  const [providerInfo, setProviderInfo] = useState(() => {
    const cfg = loadConfig()
    return { label: providerLabelFor(cfg.provider ?? "nvidia"), host: providerHostFor(cfg.baseUrl) }
  })
  /** /login wizard state: provider → (baseUrl) → apiKey → model pick.
   *  Consumed by handleInput before normal prompt routing. */
  const [loginFlow, setLoginFlow] = useState<null | {
    stage: "provider" | "baseUrl" | "apiKey" | "model"
    providerId: string
    baseUrl: string
    apiKey: string
    models: string[] | null
  }>(null)
  const loginFlowRef = useRef<typeof loginFlow>(null)
  loginFlowRef.current = loginFlow

  /** Full persisted config snapshot — covers sidebar fields the boot prop may
   *  omit (contextWindow, mcpServers, cwd). */
  const [bootConfig] = useState(() => loadConfig())
  /** Custom slash commands loaded from project/user prompt files (SKT AI LABS
   *  `{command,commands}` + `**\/*.md` glob port) — expanded and submitted as prompts. */
  const [promptCommands, setPromptCommands] = useState<PromptCommand[]>([])
  /** Last prompt the user sent — /retry resends it, Ctrl+R loads it to edit. */
  const lastUserPromptRef = useRef<string | null>(null)
  /** Nonce-tagged draft handed to the composer (Ctrl+R edit-last-prompt). */
  const [draftRequest, setDraftRequest] = useState<{ text: string; nonce: number } | null>(null)
  useEffect(() => {
    try {
      setPromptCommands(loadPromptCommands(defaultPromptCommandDirs(config?.cwd ?? process.cwd())))
    } catch {
      setPromptCommands([])
    }
  }, [config?.cwd])
  const [sidebarTodos, setSidebarTodos] = useState<SidebarTodo[]>([])
  const questionDefaultOptionRef = useRef(config?.questionDefaultOption ?? 1)
  const questionAnswerModeRef = useRef(config?.questionAnswerMode ?? "both")

  const agentRef = useRef<AgentType | null>(null)
  /** Agent config mirror — model switches update this and null agentRef so
   *  the next run rebuilds the provider with the new model. */
  const agentConfigRef = useRef<TrayambakConfig | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const resolverQueueRef = useRef<Array<{ id: string; resolve: (approved: boolean) => void }>>([])
  const permissionModeRef = useRef<PermissionMode>(permissionMode)
  permissionModeRef.current = permissionMode
  const questionResolverRef = useRef<((answers: string[]) => void) | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const currentSessionRef = useRef<SessionEntry | null>(null)
  /** One-shot type chosen in the agent picker — the next prompt runs as this subagent. */
  const pendingAgentTypeRef = useRef<string | null>(null)
  /** subagentId → transcript card routing (messageId + live toolcall counts). */
  const subagentRoutingRef = useRef<Map<string, SubagentRouting>>(new Map())
  /** Mode stack for plan-enter/exit (SKT AI LABS mode-stack parity). */
  const modeStackRef = useRef<PermissionMode[]>([])

  /** Startup update check (SKT AI LABS auto-update port): fire-and-forget so boot
   *  never blocks; "update-available" surfaces a notice, "updated" (a patch
   *  auto-applied under autoupdate:true) says restart — the running process
   *  is still the old code. Errors stay silent: a failing npm install must
   *  nag nobody on every boot. */
  useEffect(() => {
    let cancelled = false
    void checkForUpdate({ config: bootConfig, env: process.env })
      .then((outcome) => {
        if (cancelled) return
        if (outcome.kind === "update-available") {
          addSystemMessage(
            `Update available: ${outcome.current} → ${outcome.latest} (${outcome.releaseType}). Run \`trayambak upgrade\` to update.`,
          )
        } else if (outcome.kind === "updated") {
          addSystemMessage(
            `Auto-updated in background: ${outcome.previous} → ${outcome.latest}. Restart the TUI to run it (this session is still ${outcome.previous}).`,
          )
        }
      })
      .catch(() => {
        /* an update check must never break boot */
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** First boot with no key anywhere: open the provider connect
   *  automatically (kimi-style: model selection up front, no /provider
   *  hunting). Esc drops back to the welcome screen; configured users never
   *  see this. Boot must never break on a connect nudge. */
  useEffect(() => {
    try {
      const cfg = loadConfig()
      const activeId = (cfg.provider ?? "nvidia").toLowerCase()
      const entry = getCatalogEntry(activeId)
      const hasKey = readStoredKey(activeId).apiKey !== "" || (cfg.apiKey ?? "") !== ""
      if (entry?.needsApiKey && !hasKey && !loginFlowRef.current) {
        startLogin()
      }
    } catch {
      /* ignore */
    }
  }, [])

  /** Boot GitHub reconnect: a saved login stays the assistant's connection
   *  across restarts — verified once against the VPS. Live → seed the agent
   *  config so the FIRST turn already knows its operator; dead (revoked /
   *  server reset) → drop the stale saved login and say so once, instead of
   *  failing mid-task at the first write. Silent when never logged in. */
  useEffect(() => {
    let cancelled = false
    let saved: string | undefined
    let serverUrl: string | undefined
    try {
      const cfg = loadConfig()
      saved = cfg.githubLogin
      serverUrl = cfg.licenseServerUrl
    } catch {
      /* ignore */
    }
    if (saved) {
      void githubLoginStatus({ serverUrl })
        .then((st) => {
          if (cancelled) return
          if (st.authorized) {
            const login = st.login ?? saved
            agentConfigRef.current = {
              ...(agentConfigRef.current ?? createAgentConfig(config ?? {})),
              githubLogin: login,
            }
            agentRef.current = null // rebuild next turn with the operator block
            addSystemMessage(`GitHub: connected as @${login} — writes ride your login, no token needed.`, {
              persist: false,
            })
          } else {
            saveConfig({ githubLogin: undefined })
            if (agentConfigRef.current) {
              const next = { ...agentConfigRef.current }
              delete next.githubLogin
              agentConfigRef.current = next
            }
            addSystemMessage("GitHub session expired (revoked or server reset) — /github login to reconnect.", {
              persist: false,
            })
          }
        })
        .catch(() => {
          /* offline boot stays quiet — the first write surfaces it */
        })
    }
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cleanup = enableBracketedPaste()
    // Claim the tab/window title on mount. The shell (PowerShell/cmd) keeps
    // reporting its cwd as the title, so without this the tab reads "engli" (or
    // whatever folder) and gives no hint that Trayambak is the thing running.
    setTerminalTitle(buildTerminalTitle({ activity: "idle" }))
    const themeName = config?.themeName
    if (themeName) {
      const matched = applyTrayambakTheme(themeName)
      if (!matched) {
        addSystemMessage(`Unknown theme "${themeName}". Run /themes to see available options.`)
      }
    }
    return cleanup
  }, [])

  const addMessage = (msg: TrayambakMessage, opts?: { persist?: boolean }): void => {
    setMessages((prev) => [...prev, msg])
    // opts.persist === false: transcript-only rows (e.g. the "Resumed
    // session" banner) that must never reach the session log — persisting
    // them replays them as history on the next resume, duplicating the
    // banner (and any sibling rows) every single resume.
    if (opts?.persist === false) return
    if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
      if (!sessionIdRef.current) {
        const session = createSession(DEFAULT_SESSION_NAME, "")
        sessionIdRef.current = session.sessionId
        currentSessionRef.current = session
      }
      appendConversation(
        sessionIdRef.current,
        msg.role,
        msg.content ?? "",
        msg.thinking ? { thinking: msg.thinking } : undefined,
      )
    }
    if (msg.role === "assistant" && msg.toolName && msg.toolCallId) {
      appendConversation(sessionIdRef.current!, "tool", msg.content ?? "", {
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        toolStatus: msg.toolStatus === "pending" ? undefined : msg.toolStatus,
      })
    }
  }

  const addSystemMessage = (content: string, opts?: { persist?: boolean; ttlMs?: number }): string => {
    const id = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addMessage(
      {
        id,
        timestamp: Date.now(),
        role: "system",
        content,
      },
      opts,
    )
    // TTL notices ("ye text 10 second me UI se clear ho jaye"): FLAG the row
    // when the clock runs out — never splice it out. `messages` is indexed by
    // the print-once frontier; a removal would shift every later index and
    // re-print scrollback. The flag makes the live frame skip the row while
    // array, indices, and the <Static> copy stay byte-identical (rows already
    // evicted keep their printed scrollback content — off-screen anyway).
    // DEFAULT 10s: EVERY system notice fades — slash feedback, switch and
    // connect confirmations, queue/job notices, errors — so the transcript
    // holds only the conversation itself. An explicit ttlMs always wins:
    // 0 pins the prompts a user must read while input is pending (login
    // wizard steps via addLoginRow, the question prompt, the custom-answer
    // prompt).
    const ttlMs = opts?.ttlMs ?? 10_000
    if (ttlMs && ttlMs > 0) {
      const timer = setTimeout(() => {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, transientHidden: true } : m)))
      }, ttlMs)
      ;(timer as { unref?: () => void }).unref?.() // a pending notice never holds the process open
    }
    return id
  }

  /** Login-wizard rows (/login + /provider guided connect) are step-scoped: a
   *  prompt must stay on screen only while its step is live, then vanish —
   *  "if cancelled hide, if completed hide". addLoginRow records each row id;
   *  hideLoginRows flags them transientHidden (never spliced — same invariant
   *  as the TTL path: message indices and the print-once frontier stay intact).
   *  Every stage change and every flow terminal (cancel OR complete) calls
   *  hideLoginRows(); the final notice rides its own 10s TTL so even the
   *  outcome line fades away. */
  const loginRowsRef = useRef<string[]>([])

  const addLoginRow = (content: string, opts?: { persist?: boolean; ttlMs?: number }): void => {
    // Step-scoped rows: pinned (ttlMs 0) so the global 10s default cannot
    // drop a wizard question mid-flow — hideLoginRows() retires each row at
    // stage changes and flow terminals. An explicit opts.ttlMs still wins.
    loginRowsRef.current.push(addSystemMessage(content, { ttlMs: 0, ...opts }))
  }

  const hideLoginRows = (): void => {
    const ids = new Set(loginRowsRef.current)
    loginRowsRef.current = []
    if (ids.size === 0) return
    setMessages((prev) => prev.map((m) => (ids.has(m.id) ? { ...m, transientHidden: true } : m)))
  }

  /** AI auto-titles the chat: once the FIRST real reply lands (never on an
   *  error-only turn — those surface as system rows, never assistant text),
   *  the model names the session in ≤5 words and "New conversation" dies at
   *  the first exchange — the title rides the session row (sidebar, /resume
   *  list, resume banner). Fire-and-forget AFTER the turn, so it can never
   *  slow one; a name the user already chose is never clobbered; transport
   *  failures fall back to the prompt's own first words. Keyed per session
   *  id, so /newchat's fresh id re-arms it automatically. */
  const titledSessionIdRef = useRef<string | null>(null)
  /** Re-render tick for the SILENT auto-title rename: the Sidebar's title
   *  prop is read off currentSessionRef during render, and refs don't
   *  trigger renders — a bump makes the new name appear without printing a
   *  transcript row (titling is a background concern; no confirmation shown). */
  const [, setTitleEpoch] = useState(0)
  const titleSessionFromChat = async (sid: string): Promise<void> => {
    const firstUser = (messages.find((m) => m.role === "user")?.content ?? "").trim()
    const firstReply = (
      messages.find((m) => m.role === "assistant" && !m.toolCallId && (m.content ?? "").trim())?.content ?? ""
    ).trim()
    let title = ""
    if (firstUser || firstReply) {
      try {
        title = await generateChatTitle(`User: ${firstUser.slice(0, 600)}\nAssistant: ${firstReply.slice(0, 600)}`, {
          baseUrl: bootConfig.baseUrl,
          apiKey: bootConfig.apiKey,
          // Cheap-model parity (small_model): titles are background chores —
          // use the cheap model when configured, else the run's own model.
          model: bootConfig.small_model ?? bootConfig.model,
        })
      } catch {
        title = "" // provider down / odd shape → the prompt's own words below
      }
    }
    if (!title) title = firstUser.split(/\s+/).slice(0, 5).join(" ")
    title = title.replace(/\s+/g, " ").trim()
    if (!title) return
    renameSession(sid, title)
    if (currentSessionRef.current?.sessionId === sid) {
      currentSessionRef.current = { ...currentSessionRef.current, sessionName: title }
    }
    // Silent rename: no transcript row — titling runs in the background and
    // shows nothing. The bump re-renders so the Sidebar title (read off
    // currentSessionRef during render) picks the new name up immediately.
    setTitleEpoch((n) => n + 1)
  }
  useEffect(() => {
    if (turnActive) return // wait for the exchange to settle before titling
    const sid = sessionIdRef.current
    if (!sid || titledSessionIdRef.current === sid) return
    if (
      currentSessionRef.current?.sessionId === sid &&
      currentSessionRef.current.sessionName !== DEFAULT_SESSION_NAME
    ) {
      titledSessionIdRef.current = sid // the user's own name wins — ever
      return
    }
    const hasRealReply = messages.some(
      (m) => m.role === "assistant" && !m.toolCallId && (m.content ?? "").trim().length > 0,
    )
    if (!hasRealReply) return // error-only turn: nothing worth naming yet
    titledSessionIdRef.current = sid
    void titleSessionFromChat(sid)
  }, [turnActive, messages])

  /** Route a tagged child-loop event into the subagent's transcript card
   * (nested tool activity — SKT AI LABS's task parts, flattened for Ink). */
  const routeSubagentChildEvent = (event: TaggedAgentEvent): void => {
    const id = event.subagentId
    if (!id) return
    const entry = subagentRoutingRef.current.get(id)
    if (!entry) return
    // Stale-session guard: a background completion landing after /clear or
    // newchat must not rewrite the new transcript (cross-session pollution).
    // Unstamped (pre-change) entries still match.
    if (entry.sessionId !== undefined && entry.sessionId !== sessionIdRef.current) return
    const next = applyChildToolEvent(entry, event)
    if (!next) return
    subagentRoutingRef.current.set(id, next)
    if (next.background) {
      setBackgroundSubagents((prev) => {
        const map = new Map(prev)
        const job = map.get(id)
        if (job) map.set(id, { ...job, toolcalls: next.toolCalls })
        return map
      })
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === next.messageId ? { ...m, subagentToolCalls: next.toolCalls, subagentLastTool: next.lastTool } : m,
      ),
    )
  }

  /** Mark a subagent card finished (completed/error) with detail + duration. */
  const finalizeSubagentCardById = (id: string, state: "completed" | "error", detail: string): void => {
    const entry = subagentRoutingRef.current.get(id)
    if (!entry) return
    // Same stale-session guard as routeSubagentChildEvent (see above).
    if (entry.sessionId !== undefined && entry.sessionId !== sessionIdRef.current) return
    setMessages((prev) => prev.map((m) => (m.id === entry.messageId ? finalizeSubagentCard(m, { state, detail }) : m)))
  }

  const emit: AgentEventSink = (event: TaggedAgentEvent) => {
    // Child (subagent) loop events arrive tagged — route them to the card so a
    // nested turn_end/message stream can never corrupt the parent transcript.
    if (event.subagentId !== undefined && !event.type.startsWith("subagent_")) {
      routeSubagentChildEvent(event)
      return
    }

    if (event.type === "agent_start") {
      setStatus("thinking")
      setIsStreaming(/*isStreaming*/ true)
    }

    if (event.type === "turn_start") {
      setIsLoading(/*isLoading*/ true)
    }

    if (event.type === "message_start") {
      const msg = event.message
      if (msg.role === "assistant") {
        const text = msg.content.find((c) => c.type === "text")
        const content = text && "text" in text ? text.text : ""
        // streamAssistant emits message_updates DURING the stream and
        // message_start(merged) AFTER (agent-loop.ts:229-306): the last row
        // already holds streamed text+thinking. The old code blanked
        // thinking and replaced content unconditionally — reasoning
        // vanished whenever merged arrived after deltas. Merge, don't wipe.
        const thinkingPart = msg.content.find((c) => c.type === "thinking")
        const thinkingText = thinkingPart && "text" in thinkingPart ? thinkingPart.text : ""
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          // Replace the live answer row only — never a tool-call row (same
          // corruption as the delta guards above: spread would keep its
          // toolCallId and render the answer as the box's arguments).
          if (last && last.role === "assistant" && !last.toolCallId) {
            return prev.slice(0, -1).concat([
              {
                ...last,
                content: content || last.content,
                thinking: thinkingText || last.thinking || "",
              },
            ])
          }
          // Tool-call-only turns emit message_start with NO text part — the
          // tool box that follows IS the visible content. Appending an empty
          // assistant row here painted a stray blank line between two boxes
          // (one of the reported "LINES ISSUES"). Nothing to show → no row.
          if (!content && !thinkingText) return prev
          return [
            ...prev,
            {
              id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: Date.now(),
              role: "assistant",
              content: content || "",
              thinking: thinkingText || "",
            },
          ]
        })
      } else if (msg.role === "tool") {
        const toolMsg = msg as unknown as {
          role: "tool"
          toolName?: string
          content?: Array<{ type: string; text: string }>
        }
        const text = toolMsg.content?.find((c) => c.type === "text")
        const content = text ? text.text : ""
        addMessage({
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          role: "tool",
          content: content,
          toolName: toolMsg.toolName ?? "tool",
        })
      }
    }

    if (event.type === "message_update" && event.delta?.text) {
      const now = Date.now()
      const chunk = event.delta.text
      // Streaming text means the agent is alive — keep the footer truthful.
      // Without this a status parked at "idle" (permission prompt) never
      // recovered and the TUI looked stuck while text kept arriving.
      setStatus("running")
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        // NEVER fold stream text into a tool-call row (role "assistant"
        // with toolCallId): it would corrupt the box header (args JSON +
        // answer chunks) and message_start would then overwrite the row's
        // content while keeping its toolCallId — a mangled box showing the
        // answer as its arguments plus a stale result. Stream into the live
        // answer row, or open a fresh one after a tool row.
        if (last && last.role === "assistant" && !last.toolCallId) {
          return prev.slice(0, -1).concat([{ ...last, content: last.content + chunk }])
        }
        return [
          ...prev,
          {
            id: `stream-${now}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: now,
            role: "assistant",
            content: chunk,
          },
        ]
      })
    }

    if (event.type === "message_update" && event.delta?.thinking) {
      // Thinking deltas likewise own the footer label: "thinking", not a
      // stale "idle" from the approval prompt (spinner + idle = stuck look).
      setStatus("thinking")
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        // Same tool-row guard as text deltas above: thinking must never
        // land on a tool-call row (it would stick there invisibly and
        // leak into later restores). Open a fresh answer row instead of
        // dropping the delta (the old `return prev` lost thinking whenever
        // the last row wasn't an assistant one).
        if (last && last.role === "assistant" && !last.toolCallId) {
          return prev.slice(0, -1).concat([{ ...last, thinking: (last.thinking ?? "") + event.delta.thinking }])
        }
        return [
          ...prev,
          {
            id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            role: "assistant",
            content: "",
            thinking: event.delta.thinking,
          },
        ]
      })
    }

    if (event.type === "tool_execution_start") {
      const args =
        typeof event.args === "object" && event.args !== null
          ? (event.args as Record<string, unknown>)
          : { value: event.args }
      addMessage({
        id: `tool-${event.toolCallId}`,
        timestamp: Date.now(),
        role: "assistant",
        content: JSON.stringify(args),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolStatus: "running",
      })
      setStatus("running")
    }

    if (event.type === "tool_execution_update") {
      const partialText = event.partialResult?.content?.[0]?.text ?? ""
      if (partialText) {
        setMessages((prev) =>
          prev.map((m) =>
            m.toolCallId === event.toolCallId && m.role === "assistant" ? { ...m, result: partialText } : m,
          ),
        )
      }
    }

    if (event.type === "tool_execution_end") {
      if (event.isError) {
        notifyBalloon("tool-error", "TRAYAMBAK – Tool Error", `${event.toolName} failed`)
        // Terminal attention for main-turn tool errors (was balloon-only).
        notifyTerminalActivity({ activity: "error", detail: `${event.toolName} failed` })
      }
      const resultText = event.result?.content?.[0]?.text ?? ""
      setMessages((prev) =>
        prev.map((m) =>
          m.toolCallId === event.toolCallId && m.role === "assistant"
            ? {
                ...m,
                toolStatus: event.isError ? "error" : "completed",
                isError: event.isError,
                result: resultText,
              }
            : m,
        ),
      )
      // Persist the outcome onto the START row: without this the log
      // holds args-only tool rows and every resume loses all results.
      // Patched in place (never appended) so restore sees exactly one row.
      if (sessionIdRef.current) {
        updateConversationToolResult(sessionIdRef.current, event.toolCallId, {
          result: resultText,
          isError: event.isError,
          toolStatus: event.isError ? "error" : "completed",
        })
      }
      setStatus("thinking")
    }

    if (event.type === "message_end") {
      const msg = event.message
      // Stage tracer (TRAYAMBAK_DEBUG_INPUT=1): pins a silent turn end to
      // the exact message_end the loop produced (role/stopReason).
      debugInputLog(
        `STAGE message_end role=${msg?.role ?? "?"} stop=${(msg as { stopReason?: string } | undefined)?.stopReason ?? "-"}`,
      )
      if (msg?.role === "assistant") {
        const text = msg.content?.find((c) => c.type === "text")
        const thinking = msg.content?.find((c) => c.type === "thinking")
        const content = text && "text" in text ? text.text : ""
        const thinkingText = thinking && "text" in thinking ? thinking.text : ""
        if (sessionIdRef.current) {
          appendConversation(
            sessionIdRef.current,
            "assistant",
            content ?? "",
            thinkingText ? { thinking: thinkingText } : undefined,
          )
        }
        // Provider failures emit ONLY this message_end — no streamed
        // deltas, no message_start — so the old persist-only handler
        // rendered nothing: a dead endpoint left a blank transcript and
        // the send looked dead ("type hi, press Enter, nothing happens").
        // Surface it as a visible error row. It was just persisted above
        // → persist:false here to avoid a duplicate log entry. An
        // Esc-aborted close is not a model failure (the abort path
        // reports itself), so don't paint one then.
        if (
          (msg as { stopReason?: string }).stopReason === "error" &&
          content.trim() &&
          !abortControllerRef.current?.signal.aborted
        ) {
          addMessage(
            {
              id: `modelerr-${Date.now()}`,
              timestamp: Date.now(),
              role: "system",
              content,
              isError: true,
            },
            { persist: false },
          )
        }
      }
    }

    if (event.type === "permission_request") {
      // The interactive flow lives in the agent's onRequestPermission
      // callback (it creates the queue row and the resolver together, so
      // parallel tool calls can never clobber each other). The event is
      // only used for notifications/status here.
      if (event.tool !== "trayambak__AskUserQuestion") {
        notifyPermissionRequest(event.tool, event.reason)
      }
    }

    if (event.type === "turn_end") {
      // turn_end fires after EVERY tool batch inside the agent's
      // while(true) loop (agent-loop.ts:102-162) — the next turn_start is
      // imminent, so this must NOT clear isLoading/isStreaming or park at
      // idle (footer flashed "● idle" mid-turn, spinner stopped, queued
      // input saw a dead UI). Only agent_end / runAgent-finally own idle.
      // The next LLM call is thinking work: say so.
      setStatus("thinking")
    }

    if (event.type === "subagent_start") {
      const card = createSubagentCard({
        subagentId: event.subagentId,
        name: event.name,
        prompt: event.prompt,
        subagentType: event.subagentType,
        isolation: event.isolation,
        background: false,
      })
      subagentRoutingRef.current.set(event.subagentId, {
        messageId: card.id,
        background: false,
        toolCalls: 0,
        sessionId: sessionIdRef.current,
      })
      addMessage(card)
      setStatus("running")
    }

    if (event.type === "subagent_end") {
      finalizeSubagentCardById(event.subagentId, "completed", event.result ?? "")
      setStatus("thinking")
    }

    if (event.type === "subagent_fail") {
      finalizeSubagentCardById(event.subagentId, "error", event.error ?? "")
      notifyTerminalActivity({ activity: "error", detail: `Subagent ${event.name} failed` })
      // The parent turn is still alive (the failure is a CHILD event) —
      // parking at "idle" froze the footer/spinner while the outer agent
      // kept working. Mirror subagent_end: back to "thinking"; turn_end
      // owns the real idle.
      setStatus("thinking")
    }

    if (event.type === "subagent_background_start") {
      setBackgroundSubagents((prev) => {
        const next = new Map(prev).set(event.subagentId, {
          id: event.subagentId,
          name: event.name,
          prompt: event.prompt,
          status: "running",
          startedAt: Date.now(),
          isolation: event.isolation,
          subagentType: event.subagentType,
          sessionId: sessionIdRef.current,
        })
        // Cap: finished jobs otherwise accumulate forever (footer/panel
        // iterate the whole map). Drop oldest finished past 50 — running
        // jobs are never dropped.
        if (next.size > 50) {
          const finished = Array.from(next.values())
            .filter((j) => j.status !== "running")
            .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt))
          const excess = next.size - 50
          for (let i = 0; i < excess && i < finished.length; i += 1) {
            next.delete(finished[i]!.id)
          }
        }
        return next
      })
      const card = createSubagentCard({
        subagentId: event.subagentId,
        name: event.name,
        prompt: event.prompt,
        subagentType: event.subagentType,
        isolation: event.isolation,
        background: true,
      })
      subagentRoutingRef.current.set(event.subagentId, {
        messageId: card.id,
        background: true,
        toolCalls: 0,
        sessionId: sessionIdRef.current,
      })
      addMessage(card)
      setTaskHint(null)
    }

    if (event.type === "subagent_background_end") {
      setBackgroundSubagents((prev) => {
        const next = new Map(prev)
        const existing = next.get(event.subagentId)
        if (existing) {
          next.set(event.subagentId, {
            ...existing,
            status: "completed",
            result: event.result,
            completedAt: Date.now(),
          })
        }
        return next
      })
      finalizeSubagentCardById(event.subagentId, "completed", event.result ?? "")
      setTaskHint(`${g("ok")} ${event.name} finished — Ctrl+B to view`)
      // Auto-notify the main agent: without a transcript row the completion
      // is invisible to the model (only a footer hint + panel state) — the
      // "background finished but nobody told me" gap. Skipped for stale
      // sessions (/clear or newchat moved on): the note belongs to the
      // session that launched the job.
      {
        const job = backgroundSubagents.get(event.subagentId)
        if (!job || job.sessionId === undefined || job.sessionId === sessionIdRef.current) {
          const detail = (event.result ?? "").trim()
          addSystemMessage(
            `Background job "${event.name}" finished.${detail ? `\n\nResult:\n${detail.slice(0, 4000)}` : " (no result text)"}`,
          )
        }
      }
    }

    if (event.type === "subagent_background_fail") {
      // A user-cancelled job aborts its loop, which rejects into this
      // same fail path: keep the "cancelled" marking (don't flip it to a
      // noisy abort error or re-finalize the card).
      const known = backgroundSubagents.get(event.subagentId)
      if (known?.status === "cancelled") return
      setBackgroundSubagents((prev) => {
        const next = new Map(prev)
        const existing = next.get(event.subagentId)
        if (existing) {
          next.set(event.subagentId, { ...existing, status: "error", error: event.error, completedAt: Date.now() })
        }
        return next
      })
      finalizeSubagentCardById(event.subagentId, "error", event.error ?? "")
      notifyTerminalActivity({ activity: "error", detail: `Subagent ${event.name} failed` })
      // Same auto-notify as the success path above (stale-session guard
      // included): failures must reach the model too, or it will wait on
      // a background result that already died.
      {
        const job = backgroundSubagents.get(event.subagentId)
        if (!job || job.sessionId === undefined || job.sessionId === sessionIdRef.current) {
          addSystemMessage(`Background job "${event.name}" failed: ${event.error ?? "unknown error"}`)
        }
      }
    }

    if (event.type === "agent_end") {
      setIsLoading(/*isLoading*/ false)
      setIsStreaming(/*isStreaming*/ false)
      setStatus("idle")
      // No "Done" balloon on abort: agent-loop emits agent_end on the abort
      // path too, and celebrating a cancellation is a lie (and steals focus).
      if (!abortControllerRef.current?.signal.aborted) {
        notifyBalloon("done", "TRAYAMBAK – Done", "Agent finished")
      }
    }

    if (event.type === "compaction") {
      addSystemMessage(
        `${g("ok")} Context compacted: ~${event.estimatedBefore} → ~${event.estimatedAfter} tokens (freed ~${event.freedTokens}` +
          `${event.removedMessages > 0 ? `, ${event.removedMessages} messages folded` : ""}` +
          `${event.prunedToolOutputs > 0 ? `, ${event.prunedToolOutputs} tool outputs pruned` : ""}).`,
      )
    }
  }

  /** Create the shared agent on first use. Extracted from runAgent so
   * /agent launches get the identical permission + question flow (child
   * subagents inherit these callbacks via runSubagents). */
  const ensureAgent = async (): Promise<AgentType> => {
    if (!agentRef.current) {
      // Built once per instance; a model switch bumps agentConfigRef and nulls
      // agentRef so the next run reconstructs against the new model (Agent
      // bakes `model` into ProviderOptions at construction).
      agentConfigRef.current ??= createAgentConfig(config ?? {})
      agentRef.current = await Agent.create({
        config: agentConfigRef.current,
        onAskUserQuestion: async (questions) => {
          return new Promise<string[]>((resolve) => {
            questionResolverRef.current = resolve
            const q = questions[0]
            if (!q) {
              resolve([])
              return
            }
            const qid =
              typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2, 12)
            const request: QuestionRequest = {
              id: qid,
              question: q.question,
              header: q.header,
              options: q.options.map((o: { label: string; description?: string }) => ({
                label: o.label,
                description: o.description,
              })),
              multiSelect: q.multi_select,
            }
            setPendingQuestion(request)
            // Terminal attention: the title/bell/OSD path never fired for
            // the common case — the TUI sat on "working" while blocked on
            // input in another window.
            notifyTerminalActivity({ activity: "input", detail: q.question })
            const opts = request.options
              .map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`)
              .join("\n")
            addSystemMessage(
              `${g("warn")} ${request.question}\n\n` +
                `Options:\n${opts}\n\n` +
                (request.multiSelect
                  ? "Type numbers separated by spaces (e.g. 1 3), or type 'other' for custom text."
                  : "Type a number (e.g. 1), or type 'other' for custom text."),
              { ttlMs: 0 }, // input is pending — pinned until the question resolves
            )
          })
        },
        onRequestPermission: (tool, args, reason) => {
          if (tool === "trayambak__AskUserQuestion") return Promise.resolve(/*value*/ true)
          const cfg =
            ((agentRef.current?.config.permissions ?? DEFAULT_PERMISSIONS) as PermissionConfig | undefined) ??
            DEFAULT_PERMISSIONS
          const decision = evaluatePermission(tool, args, cfg, { uiMode: permissionModeRef.current })
          if (decision.action === "allow") return Promise.resolve(/*value*/ true)
          if (decision.action === "deny") {
            addSystemMessage(
              `${g("fail")} ${tool} denied by permission rule${decision.rule ? ` (${decision.rule.tool} ${decision.rule.pattern ?? "*"})` : ""}.`,
            )
            return Promise.resolve(/*value*/ false)
          }
          const rowId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const row: PermissionRequest = {
            id: rowId,
            tool,
            reason,
            args: (typeof args === "object" && args !== null ? args : { value: args }) as Record<string, unknown>,
            forceAsk: decision.source === "force-ask",
          }
          setPendingPermissions((prev) => [...prev, row])
          setStatus("idle")
          // Terminal attention for approvals (same gap as questions above).
          notifyTerminalActivity({ activity: "approval", detail: `${tool} needs approval` })
          return new Promise<boolean>((resolve) => {
            resolverQueueRef.current.push({ id: rowId, resolve })
          })
        },
      })
    }
    return agentRef.current
  }

  const runAgent = async (prompt: string): Promise<void> => {
    isRunningRef.current = true
    // Show the user's message FIRST: the pre-turn workspace snapshot used to
    // run synchronously above addMessage, freezing the whole TUI (composer
    // cleared, no bubble, no spinner) for seconds-to-minutes on big repos —
    // indistinguishable from "my message never sent". Slash commands bypass
    // runAgent entirely, which is exactly why they rendered while typed
    // messages appeared not to.
    addMessage({
      id: `user-${Date.now()}`,
      timestamp: Date.now(),
      role: "user",
      content: prompt,
    })

    setIsLoading(/*isLoading*/ true)
    setStatus("thinking")
    setIsStreaming(/*isStreaming*/ true)

    abortControllerRef.current = new AbortController()

    // No-model firewall: a Custom-style connect with no listable models can
    // land model "" — the endpoint then 400s "Missing model". Never send
    // it; point at the one-step fix instead. (activeModel mirrors the boot
    // prop + persisted config resolution, so it is the truth here.)
    const effModel = (agentConfigRef.current?.model ?? activeModel ?? "").trim()
    if (!effModel) {
      const prov = agentConfigRef.current?.provider ?? config?.provider ?? loadConfig().provider ?? "nvidia"
      addSystemMessage(
        `No model set for ${providerLabelFor(prov)} — pick one first: /models to fetch + choose, or /provider use ${prov} <exact-model-id>.`,
        { persist: false },
      )
      isRunningRef.current = false
      setIsLoading(/*isLoading*/ false)
      setIsStreaming(/*isStreaming*/ false)
      setStatus("idle")
      sweepOrphanedDialogs()
      return
    }

    // Yield once so React flushes the bubble + status before heavy work.
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Workspace checkpoint before the turn → enables /undo + Ctrl+Z.
    // captureAsync yields every 64 files: the UI stays live during the walk.
    // Off via /checkpoint off skips silently (the switch itself announced it).
    try {
      if (loadConfig().checkpointsEnabled !== false) {
        await getCheckpointStore().captureAsync(`before: ${prompt.slice(0, 60)}`)
      }
    } catch (error) {
      // Budget exceeded, oversize workspace, or unreadable files: skip the
      // checkpoint — the turn must always proceed (undo keeps the previous
      // point). Oversize gets ONE transcript note per session, not per turn.
      debugInputLog(`STAGE capture-skip msg=${error instanceof Error ? error.message : String(error)}`)
      if (error instanceof CheckpointTooBigError && !cpTooBigNotedRef.current) {
        cpTooBigNotedRef.current = true
        addSystemMessage(`${g("warn")} ${error.message} (undo keeps the previous point).`, { persist: false })
      }
    }
    debugInputLog("STAGE capture-done")

    try {
      const agent = await ensureAgent()
      debugInputLog("STAGE agent-ready")
      agent.setBackgroundEmit(emit)
      agent.config.permissions = { ...agent.config.permissions, uiMode: permissionModeRef.current }

      if (sessionIdRef.current && messages.length > 0) {
        // Sync-once: agentRef is reused across turns and agent.run() keeps
        // appending to agent.session.messages itself — pushing the FULL UI
        // history every turn duplicated turn 1 on turn 2, triplicated on
        // turn 3, exploding context. Only seed a FRESH (empty) session:
        // steady-state turns rely on the agent's own accumulation, and
        // /compact rebuilds via clear()+add() (non-empty → no reseed).
        if (agent.session.messages.length === 0) {
          const history = messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
          const agentMessages = convertToAgentMessages(history)
          agent.session.messages.push(...agentMessages)
        }
      }

      // Stage tracer (TRAYAMBAK_DEBUG_INPUT=1): pins a stalled turn to
      // checkpoint vs agent construction vs provider connect vs first token
      // instead of an eternal "Thinking…" with no clues.
      let firstEventLogged = false
      const emitTraced: AgentEventSink = (event) => {
        if (!firstEventLogged) {
          firstEventLogged = true
          debugInputLog(`STAGE first-event type=${event.type ?? "?"}`)
        }
        emit(event)
      }
      debugInputLog("STAGE run-start")
      await agent.run(prompt, emitTraced, abortControllerRef.current.signal)
      debugInputLog("STAGE run-end")
      // Auto-extract keeper facts into persistent memory (EXTRACT_MEMORIES
      // port): conservative no-LLM phrasing heuristic, max 2 fresh facts per
      // turn, off via memoryAutoExtract:false. Prompt-only by design — the
      // `messages` closure here can be a render behind, and user phrasing
      // ("remember that…", "we decided…") is the high-signal source.
      try {
        if (loadConfig().memoryAutoExtract !== false) {
          const fresh = extractAndStoreMemories(prompt, sessionIdRef.current ?? undefined)
          if (fresh.length > 0) {
            addSystemMessage(
              `${g("ok")} Saved to memory: ${fresh.map((e) => e.content.slice(0, 80)).join(" · ")}  (/memory lists all)`,
              { persist: false },
            )
          }
        }
      } catch {
        /* auto-memory never breaks turns */
      }
    } catch (error) {
      debugInputLog(`STAGE error msg=${error instanceof Error ? error.message : String(error)}`)
      setStatus("error")
      addMessage({
        id: `error-${Date.now()}`,
        timestamp: Date.now(),
        role: "system",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      })
    } finally {
      isRunningRef.current = false
      setIsLoading(/*isLoading*/ false)
      setIsStreaming(/*isStreaming*/ false)
      setStatus("idle")
      // The agent unwound: any dialog rows it was awaiting are orphans and
      // would keep the composer disabled forever ("stuck" input). Sweep them
      // before the next queued turn can open fresh ones.
      sweepOrphanedDialogs()
      // Prompt-queue handoff: run the next queued prompt, if any.
      if (queueRef.current.length > 0) {
        const next = queueRef.current.shift()
        setQueuedPrompts([...queueRef.current])
        if (next !== undefined) {
          addSystemMessage(`${g("dot")} Running queued prompt (${queueRef.current.length} still queued)`)
          void runAgent(next).catch(reportTurnError)
        }
      }
    }
  }

  /** Escaped rejection from a fire-and-forget turn (`void runAgent(…)`):
   *  Node's default unhandled-rejection handling would take the whole TUI
   *  down — surface it inline and flip the footer to error instead. */
  const reportTurnError = (error: unknown): void => {
    addSystemMessage(`${g("fail")} ${error instanceof Error ? error.message : String(error)}`)
    setStatus("error")
    setIsLoading(/*isLoading*/ false)
    // Without this the last message stays "unstable" forever (MessageList
    // pins the last row dynamic while isStreaming) and <Static> never
    // prints it — footer spinner stuck after a queued-turn rejection.
    setIsStreaming(/*isStreaming*/ false)
    sweepOrphanedDialogs()
  }

  const handleInput = (value: string): void => {
    debugInputLog(`SUBMIT value=${JSON.stringify(value)}`)
    // Provider-connect wizard owns the composer while active (provider →
    // baseUrl → apiKey → model). Slash passthrough is disabled here except
    // the hidden /login-cancel hatch (Esc is the advertised exit).
    const flow = loginFlowRef.current
    if (flow) {
      const raw = value.trim()
      if (raw === "/login-cancel" || raw === "/login_cancel") {
        cancelLogin()
        return
      }
      if (raw.startsWith("/") && raw.length > 1) {
        addSystemMessage(
          "Finish the provider connect first (or Esc to cancel) — slash commands are paused mid-connect.",
          { persist: false, ttlMs: 10_000 },
        )
        return
      }
      void advanceLogin(raw)
      return
    }
    // Question answers: capture-then-null the resolver BEFORE invoking it.
    // A resolver may chain the NEXT question (devmode chooser → license
    // paste) and re-set this ref; nulling after the call wiped the chained
    // resolver — the next answer then resolved against a null ref (silent
    // no-op: no unlock, no message, no menu). Same order as the Esc path.
    if (waitingCustom && pendingQuestion) {
      setWaitingCustom(/*waitingCustom*/ false)
      const q = pendingQuestion
      const answer = value.trim()
      setPendingQuestion(null)
      const resolve = questionResolverRef.current
      questionResolverRef.current = null
      resolve?.(answer.length > 0 ? (q.multiSelect ? [answer] : [answer]) : [])
      return
    }
    if (pendingQuestion) {
      const q = pendingQuestion
      const input = value.trim().toLowerCase()
      const mode = questionAnswerModeRef.current
      const defaultOpt = questionDefaultOptionRef.current
      if (input.length === 0) {
        setPendingQuestion(null)
        const resolve = questionResolverRef.current
        questionResolverRef.current = null
        if (mode === "choose" || mode === "both") {
          const idx = Math.min(defaultOpt - 1, q.options.length - 1)
          resolve?.(q.multiSelect ? [] : [q.options[idx]?.label ?? ""])
        } else {
          resolve?.([])
        }
        return
      }
      if (input === "other") {
        if (mode === "choose") return
        setWaitingCustom(/*waitingCustom*/ true)
        addSystemMessage("Type your custom answer (press Enter to submit):", { ttlMs: 0 })
        return
      }
      if (mode === "type") {
        setPendingQuestion(null)
        const resolve = questionResolverRef.current
        questionResolverRef.current = null
        resolve?.(q.multiSelect ? [input] : [input])
        return
      }
      const parts = input.split(/[\s,]+/).filter(Boolean)
      const answers: string[] = []
      for (const p of parts) {
        const idx = parseInt(p, 10) - 1
        if (idx >= 0 && idx < q.options.length) {
          answers.push(q.options[idx].label)
        } else if (mode === "both") {
          answers.push(p)
        }
      }
      setPendingQuestion(null)
      const resolve = questionResolverRef.current
      questionResolverRef.current = null
      resolve?.(q.multiSelect ? answers : [answers[0] ?? ""])
      return
    }
    if (pendingAgentTypeRef.current && value.trim()) {
      const type = pendingAgentTypeRef.current
      let prompt = value.trim()
      let background = false
      if (prompt === "--bg") {
        addSystemMessage("Add the task prompt after --bg, e.g. --bg audit the auth flow for token reuse")
        return
      }
      if (prompt.startsWith("--bg ")) {
        background = true
        prompt = prompt.slice(5).trim()
      }
      if (!prompt) return
      pendingAgentTypeRef.current = null
      void launchSubagent(type, prompt, background)
      return
    }
    if (value.trim()) {
      const v = value.trim()
      lastUserPromptRef.current = v
      if (isRunningRef.current || isLoading) {
        // Queue instead of silently dropping (SKT AI LABS prompt queue).
        queueRef.current.push(v)
        setQueuedPrompts([...queueRef.current])
        const shown = v.length > 80 ? `${v.slice(0, 80)}…` : v
        addSystemMessage(
          `⛓ Queued (#${queueRef.current.length}): ${shown}\n` +
            `Runs automatically when the current turn finishes — /queue list · /queue drop <n> · /queue clear · Ctrl+X clears`,
        )
      } else {
        // Submit-time snap (the only one — nothing re-zeroes mid-turn).
        setScrollBack(0)
        void runAgent(v).catch(reportTurnError)
      }
    }
  }

  /** Launch a subagent from the UI (/agent run, picker, or --bg). Foreground
   * runs stream into their own transcript card; background runs land in the
   * background map + footer/panel. */
  const launchSubagent = async (type: string, prompt: string, background: boolean): Promise<void> => {
    try {
      const agent = await ensureAgent()
      agent.setBackgroundEmit(emit)
      agent.config.permissions = { ...agent.config.permissions, uiMode: permissionModeRef.current }
      const flattened = prompt.replace(/\s+/g, " ").trim()
      const desc = flattened.length > 60 ? `${flattened.slice(0, 60)}…` : flattened
      const name = formatSubagentTitle(type, desc, background)
      addSystemMessage(
        `${background ? g("ring") : g("dot")} Launching ${background ? "background " : ""}subagent [${type}]: ${desc}`,
      )
      const results = await agent.runSubagents([{ name, prompt, subagentType: type, background }], emit)
      const first = results[0]
      if (first?.error) {
        addSystemMessage(`${g("fail")} Subagent [${type}] failed: ${first.error}`)
      }
    } catch (error) {
      addSystemMessage(`Subagent error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Cancel a running background job (SubagentPanel X key): abort its loop,
   *  mark the map entry + transcript card cancelled. Previously background
   *  jobs were unabortable — Ctrl+D only aborted the foreground controller
   *  while child.run() held `undefined` as its signal. */
  const cancelBackgroundJob = (id: string): void => {
    const job = backgroundSubagents.get(id)
    if (!job || job.status !== "running") {
      addSystemMessage("No such running background job.")
      return
    }
    agentRef.current?.cancelBackgroundJob(id)
    setBackgroundSubagents((prev) => {
      const next = new Map(prev)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, status: "cancelled", completedAt: Date.now() })
      return next
    })
    finalizeSubagentCardById(id, "error", "Cancelled by user.")
    setTaskHint(`${g("spinnerDot")} ${job.name} cancelled`)
  }

  const getCheckpointStore = (): CheckpointStore => {
    // Silent guard: the home/root refusal used to print a boot notice, but
    // it fired for every session launched outside a project and read as
    // junk — /checkpoint status reports the state on demand instead.
    if (!checkpointStoreRef.current) {
      checkpointStoreRef.current = new CheckpointStore(config?.cwd ?? process.cwd())
    }
    return checkpointStoreRef.current
  }

  const undoCheckpoint = (): void => {
    if (isRunningRef.current) {
      addSystemMessage("⏳ Agent is running — wait for the turn to finish before undoing.")
      return
    }
    if (loadConfig().checkpointsEnabled === false) {
      addSystemMessage("Checkpoints are OFF — /checkpoint on to re-enable.")
      return
    }
    try {
      const res = getCheckpointStore().undo()
      addSystemMessage(res.ok ? res.message : `Nothing to undo: ${res.reason}`)
    } catch (error) {
      addSystemMessage(`Undo failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const redoCheckpoint = (): void => {
    if (isRunningRef.current) {
      addSystemMessage("⏳ Agent is running — wait for the turn to finish before redoing.")
      return
    }
    if (loadConfig().checkpointsEnabled === false) {
      addSystemMessage("Checkpoints are OFF — /checkpoint on to re-enable.")
      return
    }
    try {
      const res = getCheckpointStore().redo()
      addSystemMessage(res.ok ? res.message : `Nothing to redo: ${res.reason}`)
    } catch (error) {
      addSystemMessage(`Redo failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** SKT AI LABS sparkle port: rewrite a draft via the configured chat model. Never
   *  answers, never throws — failures come back as { ok: false } so the
   *  composer can show them inline without losing the draft. */
  const enhanceDraft = async (draft: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    try {
      const text = await enhancePrompt(draft, {
        baseUrl: bootConfig.baseUrl,
        apiKey: bootConfig.apiKey,
        model: bootConfig.model,
      })
      return { ok: true, text }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const handleSlashCommand = (command: string, args: string): void => {
    // Provider connect owns the composer while active: only the hidden
    // /login-cancel hatch runs (Esc is the advertised exit).
    if (loginFlowRef.current && command !== "login-cancel" && command !== "login_cancel") {
      addSystemMessage(
        "Finish the provider connect first (or Esc to cancel) — slash commands are paused mid-connect.",
        { persist: false },
      )
      return
    }
    // Project/user prompt files (SKT AI LABS command files): a matching .md template
    // expands with the typed arguments and submits as a normal prompt.
    // Built-ins win a name collision — these can add commands, never shadow.
    const isBuiltin =
      SLASH_COMMANDS.some((c) => c.name === command) || slashCommandService.registry.resolve(command) !== undefined
    if (!isBuiltin) {
      const promptCmd = promptCommands.find((c) => c.name.toLowerCase() === command.toLowerCase())
      if (promptCmd) {
        const expanded = expandPromptCommand(promptCmd.body, args).trim()
        if (expanded) {
          handleInput(expanded)
        } else {
          addSystemMessage(`Prompt file expanded to nothing: ${promptCmd.file}`)
        }
        return
      }
    }
    switch (command) {
      case "help":
        addSystemMessage(SLASH_COMMANDS.map((cmd) => `/${cmd.name} — ${cmd.description}`).join("\n"))
        break
      case "keymap":
        addSystemMessage(formatKeymapMessage())
        break
      case "enhance":
        // The composer intercepts /enhance to rewrite its buffer directly;
        // reaching this handler means it ran without a draft (palette/leader).
        addSystemMessage(
          "Type your draft and press Ctrl+E (or `/enhance <draft>`) to rewrite it, review the result, then send.",
        )
        break
      case "queue": {
        const sub = args.trim()
        if (sub === "clear" || sub === "drop") {
          const n = queueRef.current.length
          queueRef.current = []
          setQueuedPrompts([])
          addSystemMessage(`Cleared ${n} queued prompt${n === 1 ? "" : "s"}.`)
        } else if (sub.startsWith("drop")) {
          const n = parseInt(sub.slice(4).trim(), 10)
          if (!Number.isFinite(n) || n < 1 || n > queueRef.current.length) {
            addSystemMessage(`Usage: /queue drop <1-${queueRef.current.length}>`)
          } else {
            const [removed] = queueRef.current.splice(n - 1, 1)
            setQueuedPrompts([...queueRef.current])
            addSystemMessage(`Dropped queued #${n}: ${(removed ?? "").slice(0, 60)}`)
          }
        } else if (queueRef.current.length === 0) {
          addSystemMessage("Queue is empty.")
        } else {
          addSystemMessage(
            `Queued prompts (${queueRef.current.length}):\n` +
              queueRef.current.map((p, i) => `${i + 1}. ${p}`).join("\n"),
          )
        }
        break
      }
      case "compact": {
        if (!agentRef.current) {
          addSystemMessage("No active session yet.")
          break
        }
        const res = compactMessages(agentRef.current.session.messages, policyFromConfig(config ?? {}), {
          force: true,
          systemPrompt: agentRef.current.session.systemContext,
        })
        if (!res.changed) {
          addSystemMessage(`Nothing to compact — session is ~${res.estimatedBefore} tokens.`)
          break
        }
        agentRef.current.session.clear()
        for (const m of res.messages) agentRef.current.session.add(m)
        // Say the transcript diverges: compaction rewrote the MODEL's
        // session, but the visible transcript keeps every row. Without this
        // note the next answers look unhinged relative to what's on screen.
        addSystemMessage(
          `${g("ok")} Compacted: ~${res.estimatedBefore} → ~${res.estimatedAfter} tokens` +
            `${res.removedMessages > 0 ? ` · ${res.removedMessages} messages folded` : ""}` +
            `${res.prunedToolOutputs > 0 ? ` · ${res.prunedToolOutputs} tool outputs pruned` : ""}. ` +
            `Note: the transcript above is unchanged — the model now sees the compacted version.`,
        )
        break
      }
      case "undo":
        undoCheckpoint()
        break
      case "redo":
        redoCheckpoint()
        break
      case "checkpoints": {
        if (args.trim().toLowerCase() === "prune confirm") {
          const res = getCheckpointStore().prune()
          addSystemMessage(
            res.removed === 0 && res.bytes === 0
              ? "Nothing to prune — no checkpoint data on disk."
              : `${g("ok")} Pruned ${res.removed} checkpoint${res.removed === 1 ? "" : "s"}, reclaimed ${(res.bytes / 1048576).toFixed(1)}MB. Undo history starts fresh.`,
          )
          break
        }
        if (args.trim().toLowerCase() === "prune") {
          addSystemMessage("This deletes ALL checkpoints (undo history). Type '/checkpoints prune confirm' to proceed.")
          break
        }
        const cps = getCheckpointStore().list()
        if (cps.length === 0) {
          addSystemMessage("No checkpoints yet — one is captured before every agent turn.")
        } else {
          addSystemMessage(
            "Checkpoints (oldest → newest):\n" +
              cps
                .map(
                  (cp) =>
                    `#${cp.id} ${cp.label} · ${cp.fileCount} files · ${new Date(cp.createdAt).toLocaleTimeString()}`,
                )
                .join("\n"),
          )
        }
        break
      }
      case "checkpoint": {
        const arg = args.trim().toLowerCase()
        const enabled = loadConfig().checkpointsEnabled !== false
        if (arg === "on" || arg === "off") {
          const next = arg === "on"
          saveConfig({ checkpointsEnabled: next })
          addSystemMessage(
            next
              ? `${g("ok")} Checkpoints ON — captured before every turn (saved — survives restart).`
              : `${g("fail")} Checkpoints OFF — no captures; /undo and /redo report the state (saved — survives restart).`,
          )
        } else {
          const count = (() => {
            try {
              return getCheckpointStore().list().length
            } catch {
              return 0
            }
          })()
          addSystemMessage(
            `Checkpoints: ${enabled ? "ON" : "OFF"} · ${count} stored point${count === 1 ? "" : "s"}\n/checkpoint on|off — switch · /checkpoints — list · /checkpoints prune confirm — delete all`,
            { persist: false },
          )
        }
        break
      }
      case "clear":
      case "reset":
        setMessages([])
        setStaticEpoch((e) => e + 1)
        // Routing owns card messageIds of the wiped transcript — late child
        // completions must not resurrect/mutate rows in the fresh one.
        // (Background jobs themselves keep running; their results stay in
        // the background map for Ctrl+B.)
        subagentRoutingRef.current.clear()
        break
      case "exit":
      case "quit":
        abortControllerRef.current?.abort()
        sweepOrphanedDialogs()
        onExit?.()
        break
      case "mode":
      case "permissions":
      case "permission": {
        const modeMap: Record<string, PermissionMode> = {
          "read-only": "read-only",
          readonly: "read-only",
          plan: "plan",
          ask: "ask",
          "auto-approve": "auto-approve",
          autoapprove: "auto-approve",
          auto: "auto-approve",
          "full-access": "full-access",
          fullaccess: "full-access",
          full: "full-access",
        }
        // Normalize human spacing ("full access", "auto  approve") to the
        // hyphenated ids — otherwise a natural typing silently falls to
        // Usage and the mode "never changes".
        const arg = args.trim().toLowerCase().replace(/\s+/g, "-")
        const state = { current: permissionModeRef.current, stack: modeStackRef.current }
        if (!arg) {
          const crumb = formatModeStack(state)
          // Show whether this mode survives a restart: the saved value is
          // what the next boot reads. Kills the "it auto shifts to ASK"
          // confusion at its root — the answer is printed, not guessed.
          // Transient (persist:false): a read-only status query must not
          // bloat the log, the token count, or the model's context with a
          // ~30-token readout every time it runs.
          let savedNote = ""
          try {
            const saved = loadConfig().permissions?.uiMode
            savedNote = isPermissionMode(saved)
              ? saved === state.current
                ? " (saved — survives restart)"
                : ` (saved: ${saved.toUpperCase()} — change once to persist ${state.current.toUpperCase()})`
              : " (not saved yet — change it once to persist across restarts)"
          } catch {
            savedNote = " (saved state unreadable)"
          }
          addSystemMessage(
            `Permission mode: ${state.current.toUpperCase()}${savedNote}${crumb ? ` (stack: ${crumb} — /mode exit returns)` : ""}`,
            { persist: false, ttlMs: 10_000 },
          )
          break
        }
        if (arg === "exit" || arg === "back") {
          const next = exitMode(state)
          if (next === state) {
            addSystemMessage(`Not in plan mode — nothing to exit (mode: ${state.current.toUpperCase()}).`)
          } else {
            modeStackRef.current = next.stack
            setPermissionMode(next.current)
            syncUiMode(next.current)
            addSystemMessage(
              `Plan mode OFF — back to ${next.current.toUpperCase()}. Mutating tools follow that mode's rules. (saved — survives restart)`,
              { ttlMs: 10_000 },
            )
          }
          break
        }
        const nextMode = modeMap[arg]
        if (arg === "rules" || arg === "list") {
          // Rule inspector: there was no way to SEE effective rules in-TUI,
          // so stale config denies (e.g. a legacy write_file/edit_file deny)
          // silently overruled every mode including full-access — "permission
          // stays ASK". Precedence: full-access bypasses all; auto-approve
          // skips stock defaults (only deletes + your own session/config
          // rules gate); other modes: session > config > default, deny
          // beats allow within a layer; force-ask prompts unless
          // full-access (auto-approve: deletes only).
          const fmt = (r: { tool: string; pattern?: string; action: string; reason?: string }): string =>
            `${r.action.toUpperCase()} ${r.tool} → ${r.pattern ?? "*"}${r.reason ? ` (${r.reason})` : ""}`
          const session = getSessionPermissionRules()
          let cfgRulesV2: Array<{ tool: string; pattern?: string; action: string; reason?: string }> = []
          let cfgLegacy: Array<{ tool: string; pattern?: string; allow?: boolean; action?: string }> = []
          try {
            const perms = loadConfig().permissions as
              { rulesV2?: typeof cfgRulesV2; rules?: typeof cfgLegacy } | undefined
            cfgRulesV2 = perms?.rulesV2 ?? []
            cfgLegacy = perms?.rules ?? []
          } catch {
            /* unreadable config shows as empty below */
          }
          const lines = [
            `Mode: ${state.current.toUpperCase()} (full-access: nothing blocks · auto-approve: only deletes + your own rules gate)`,
            `Session rules (${session.length}):${session.length > 0 ? "" : " none"}`,
            ...session.map((r) => `  • ${fmt(r)}`),
            `Config rulesV2 (${cfgRulesV2.length}):${cfgRulesV2.length > 0 ? "" : " none"}`,
            ...cfgRulesV2.map((r) => `  • ${fmt(r)}`),
            `Config legacy rules (${cfgLegacy.length}):${cfgLegacy.length > 0 ? "" : " none"}`,
            ...cfgLegacy.map(
              (r) =>
                `  • ${(r.action ?? (r.allow === false ? "deny" : "allow")).toUpperCase()} ${r.tool} → ${r.pattern ?? "*"}`,
            ),
            `To remove a stale config deny, edit ${"config.json"} (${"permissions.rules"} / ${"permissions.rulesV2"}) — deny beats mode at every layer.`,
          ]
          addSystemMessage(lines.join("\n"))
          break
        }
        if (nextMode) {
          const next = enterMode(state, nextMode)
          modeStackRef.current = next.stack
          setPermissionMode(next.current)
          syncUiMode(next.current)
          addSystemMessage(
            `Permission mode: ${nextMode.toUpperCase()}${nextMode === "plan" && state.current !== "plan" ? " (pushed — /mode exit returns)" : ""} (saved — survives restart)`,
            { ttlMs: 10_000 },
          )
        } else {
          addSystemMessage(
            "Usage: /mode <read-only|plan|ask|auto-approve|full-access> | /mode exit | /mode | /mode rules (spaces work too: /mode full access)",
          )
        }
        break
      }
      case "gate": {
        // Real state instead of the old echo: gateEnabled lives in
        // developerMode (the engine reads it via isGateEnabled()), so
        // "status" is truthful and the /devmode menu has something to
        // actually mention. A bare /gate shows status, not usage.
        const garg = args.trim().toLowerCase()
        if (garg === "on" || garg === "off") {
          const developerMode = { ...loadConfig().developerMode, gateEnabled: garg === "on" }
          saveConfig({ developerMode })
          agentConfigRef.current = { ...(agentConfigRef.current ?? createAgentConfig(config ?? {})), developerMode }
          agentRef.current = null // rebuild next turn so the engine picks the flag up
          addSystemMessage(`Streaming gate ${garg === "on" ? "enabled" : "disabled"} (saved).`)
        } else if (garg === "status" || garg === "") {
          const on = loadConfig().developerMode?.gateEnabled === true
          addSystemMessage(`Streaming gate: ${on ? "ON" : "OFF"} (/gate on|off).`, { persist: false })
        } else {
          addSystemMessage("Usage: /gate on|off|status")
        }
        break
      }
      case "github": {
        // CLI ↔ VPS ↔ GitHub authorize loop: login hands the user a browser
        // URL (server-bound to this machine), status/logout manage it, and
        // issue reads an issue + comments through the stored user token.
        const gparts = args.trim().split(/\s+/).filter(Boolean)
        const gsub = (gparts[0] ?? "").toLowerCase()
        const serverUrl = loadConfig().licenseServerUrl
        if (gsub === "login") {
          // Stacked pollers wrote competing outcome rows (blink): one login
          // at a time; a retype while waiting parks with a notice.
          if (githubLoginBusyRef.current) {
            addSystemMessage("GitHub login already in progress — approve in the browser, or wait for it to time out.", {
              persist: false,
            })
            break
          }
          githubLoginBusyRef.current = true
          // Progress rows PINNED (ttlMs 0): the default 10s TTL collapsed
          // each row mid-wait and reflowed the frame under the 60s poll.
          // Only the final Authorized/Failed outcome fades.
          addSystemMessage("Asking the server for a GitHub authorize URL…", { persist: false, ttlMs: 0 })
          void startGithubLogin({ serverUrl }).then((s) => {
            if (!s.ok || !s.url) {
              githubLoginBusyRef.current = false
              addSystemMessage(`GitHub login unavailable — ${s.reason ?? "unknown error"}.`)
              return
            }
            // Browser first (seconds, no copy-paste): fall back to the
            // printed URL only where no browser can open (SSH/headless).
            if (openBrowser(s.url)) {
              addSystemMessage("Browser me GitHub authorize page khol di — Approve dabao, CLI khud pakad lega…", {
                persist: false,
                ttlMs: 0,
              })
            } else {
              addSystemMessage(`Open this URL in your browser to authorize:\n${s.url}`, { persist: false, ttlMs: 0 })
            }
            addSystemMessage("Waiting up to ~60s for approval…", { persist: false, ttlMs: 0 })
            void pollGithubLogin({ serverUrl }).then((p) => {
              githubLoginBusyRef.current = false
              if (p.authorized) {
                // Persist the login so the system prompt names its operator
                // (and /github status stays truthful across restarts).
                const login = p.login ?? "github-user"
                saveConfig({ githubLogin: login })
                agentConfigRef.current = {
                  ...(agentConfigRef.current ?? createAgentConfig(config ?? {})),
                  githubLogin: login,
                }
                agentRef.current = null // rebuild next turn with the operator block
                addSystemMessage(`GitHub authorized as ${p.login ?? "you"} — /github issue <owner/repo#n> to read.`)
              } else {
                addSystemMessage(`GitHub login failed — ${p.reason ?? "not approved"}.`)
              }
            })
          })
        } else if (gsub === "logout") {
          void githubLogout({ serverUrl }).then((r) => {
            if (r.ok) {
              saveConfig({ githubLogin: undefined })
              const next = { ...(agentConfigRef.current ?? createAgentConfig(config ?? {})) }
              delete next.githubLogin
              agentConfigRef.current = next
              agentRef.current = null
            }
            addSystemMessage(r.ok ? "GitHub logged out on this machine." : `Logout failed — ${r.reason ?? "unknown"}.`)
          })
        } else if (gsub === "status") {
          void githubLoginStatus({ serverUrl }).then((st) => {
            addSystemMessage(
              st.authorized ? `GitHub: authorized as ${st.login ?? "you"}.` : "GitHub: not logged in (/github login).",
              { persist: false },
            )
          })
        } else if (gsub === "issue") {
          // Forms: /github issue owner/repo#12 · /github issue owner/repo 12
          const rest = gparts.slice(1).join(" ")
          const m = rest.match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([^/\s]+\/[^/\s#]+)(?:#(\d+)|\s+(\d+))?$/)
          const repo = (m?.[1] ?? "").replace(/\.git$/, "")
          const num = Number(m?.[2] ?? m?.[3] ?? "")
          if (!repo || !Number.isFinite(num) || num < 1) {
            addSystemMessage("Usage: /github issue <owner/repo#n> — e.g. /github issue SHRIJANAGAIN/SKT-AMD-FILES#1")
            break
          }
          addSystemMessage(`Reading ${repo}#${num} via the server…`, { persist: false })
          void readGithubIssue(repo, num, { serverUrl }).then((r) => {
            if (!r.ok || !r.issue) {
              addSystemMessage(`GitHub read failed — ${r.reason ?? "unknown"}.`)
              return
            }
            const iss = r.issue
            const comments = (r.comments ?? [])
              .slice(-5)
              .map((c) => `\n— ${c.author}:\n${c.body.slice(0, 500)}`)
              .join("\n")
            addSystemMessage(
              `#${iss.number} [${iss.state}] ${iss.title}\n${iss.author} · ${iss.url}\n---\n${iss.body.slice(0, 3000) || "(empty)"}${
                comments ? `\n--- recent comments ---${comments}` : ""
              }`,
            )
          })
        } else {
          addSystemMessage("Usage: /github login|logout|status|issue <owner/repo#n>")
        }
        break
      }
      case "status":
        // Transient like /mode: a status readout must not bloat the log or
        // feed the model its own status chatter every time it runs.
        addSystemMessage(`Status: ${status}\nMode: ${permissionMode}\nTokens: ${tokenCount}`, {
          persist: false,
        })
        break
      case "model":
        addSystemMessage(`Current model: ${activeModel}`)
        break
      case "models": {
        const cfg = loadConfig()
        const prov = cfg.provider ?? "nvidia"
        const entry = getCatalogEntry(prov)
        // No key on a key-gated backend: the fetch would 401 into the tiny
        // static list — ask for the key instead of opening a dead picker.
        if (entry?.needsApiKey && !cfg.apiKey) {
          hideLoginRows()
          setLoginFlow({ stage: "apiKey", providerId: entry.id, baseUrl: cfg.baseUrl, apiKey: "", models: null })
          addLoginRow(
            `${g("prompt")} ${entry.label}: no API key saved — paste it (or type 'skip'), and the live model list follows. Esc cancels.`,
            { persist: false, ttlMs: 0 },
          )
          break
        }
        addSystemMessage(`Fetching models for ${providerLabelFor(prov)}…`, { persist: false, ttlMs: 10_000 })
        void fetchModelsDetailed(prov, cfg.baseUrl, cfg.apiKey).then((res) => {
          const { models, tag } = resolveModels(prov, res)
          setAvailableModels(models)
          setShowModelPicker(/*showModelPicker*/ true)
          addSystemMessage(
            models.length > 0
              ? `Choose in the picker ↑↓ Enter (${models.length} ${tag}).`
              : `No models returned — check the provider/key/endpoint.${fetchWarn(res.error)}`,
            { persist: false, ttlMs: 10_000 },
          )
        })
        break
      }
      case "login-cancel":
      case "login_cancel":
        cancelLogin()
        break
      case "provider": {
        const parts = args.trim().split(/\s+/).filter(Boolean)
        const sub = (parts[0] ?? "").toLowerCase()
        const rest = parts.slice(1)
        const cfg = loadConfig()
        // Bare /provider opens the backend chooser (permission-menu style):
        // pick → key (if needed) → live models → model chooser. /provider
        // list stays a quiet status readout.
        if (sub === "") {
          startLogin()
          break
        }
        if (sub === "list") {
          // Compact status by default — the full 9-row catalog dump was
          // transcript junk. `/provider list all` still prints everything.
          const activeId = (cfg.provider ?? "nvidia").toLowerCase()
          if (rest[0] === "all" || rest[0] === "full") {
            const lines = PROVIDER_CATALOG.map((e) => {
              const mark = activeId === e.id ? `${g("dot")} ` : "  "
              const keyMark = activeId === e.id && cfg.apiKey ? ` (key ${g("ok")})` : ""
              return `${mark}${e.label} (${e.id}) — ${e.defaultBaseUrl}${keyMark}`
            })
            addSystemMessage(`Providers:\n${lines.join("\n")}`)
          } else {
            addSystemMessage(
              `${g("dot")} ${providerLabelFor(cfg.provider ?? "nvidia")} · ${cfg.model}${cfg.apiKey ? ` · key ${g("ok")}` : " · no key"}\n` +
                `/provider — backend chooser · /provider use <id> [model] · /provider add — guided connect · /provider key — set/check API keys · /provider models — chooser`,
            )
          }
        } else if (sub === "use") {
          // Guided switch: /provider use <id> [model]. With an explicit model
          // it swaps quietly; without one it runs the login data inline —
          // key (if needed) → live fetch → model chooser.
          const id = (rest[0] ?? "").toLowerCase()
          const entry = getCatalogEntry(id)
          const sameKey = (cfg.provider ?? "").toLowerCase() === id ? cfg.apiKey : readStoredKey(id).apiKey
          if (!entry) {
            addSystemMessage(
              `${g("dot")} ${providerLabelFor(cfg.provider ?? "nvidia")} · ${cfg.model}\nUsage: /provider use <id> [model] — ids: ${PROVIDER_CATALOG.map((e) => e.id).join(", ")}`,
            )
          } else if (rest.length > 1) {
            const model = rest.slice(1).join(" ")
            applyProviderSwitch(entry.id, model, entry.defaultBaseUrl, sameKey)
            addSystemMessage(`Switched: ${entry.label} · ${model}`)
          } else if (isRunningRef.current || isLoading) {
            addSystemMessage("Finish or abort the running turn first — switching needs a free composer.")
          } else if (loginFlow) {
            addSystemMessage("Connect already in progress — answer the pending step or press Esc.")
          } else {
            const base = (cfg.provider ?? "").toLowerCase() === id ? cfg.baseUrl : entry.defaultBaseUrl
            if (entry.needsApiKey && !sameKey) {
              hideLoginRows()
              setLoginFlow({ stage: "apiKey", providerId: entry.id, baseUrl: base, apiKey: "", models: null })
              addLoginRow(
                `${g("prompt")} ${entry.label}: enter API key (models fetch + chooser follow). Esc to abort.`,
                {
                  persist: false,
                  ttlMs: 0,
                },
              )
            } else {
              void fetchAndPickModel(entry.id, base, sameKey)
            }
          }
        } else if (sub === "models") {
          const id = (rest[0] ?? cfg.provider ?? "nvidia").toLowerCase()
          const entry = getCatalogEntry(id)
          if (!entry) {
            addSystemMessage(`Unknown provider "${rest[0]}".`)
          } else {
            const base = (cfg.provider ?? "").toLowerCase() === id ? cfg.baseUrl : entry.defaultBaseUrl
            const key = (cfg.provider ?? "").toLowerCase() === id ? cfg.apiKey : ""
            const isActive = (cfg.provider ?? "").toLowerCase() === id
            if (isActive && entry.needsApiKey && !key) {
              hideLoginRows()
              setLoginFlow({ stage: "apiKey", providerId: id, baseUrl: base, apiKey: "", models: null })
              addLoginRow(
                `${g("prompt")} ${entry.label}: no API key saved — paste it (or type 'skip'), and the live model list follows. Esc cancels.`,
                { persist: false, ttlMs: 0 },
              )
              break
            }
            addSystemMessage(`Fetching models for ${entry.label}…`, { persist: false, ttlMs: 10_000 })
            void fetchModelsDetailed(id, base, key).then((res) => {
              if (isActive) {
                // Active backend → straight into the chooser, no text dump.
                const { models, tag } = resolveModels(id, res)
                setAvailableModels(models)
                setShowModelPicker(/*showModelPicker*/ true)
                addSystemMessage(
                  models.length > 0
                    ? `Choose in the picker ↑↓ Enter (${models.length} ${tag}).`
                    : `No models for ${entry.label} — check key/endpoint.${fetchWarn(res.error)}`,
                  { persist: false, ttlMs: 10_000 },
                )
                return
              }
              // Other backends are browse-only here (picker acts on active).
              addSystemMessage(
                res.models.length > 0
                  ? `${entry.label} models (${res.models.length}, ${res.source}):\n${res.models.slice(0, 10).join("\n")}${res.models.length > 10 ? `\n… +${res.models.length - 10} more — /provider use ${id} to choose` : ""}${fetchWarn(res.error)}`
                  : `No models for ${entry.label} — check key/endpoint.${fetchWarn(res.error)}`,
                { ttlMs: 10_000 },
              )
            })
          }
        } else if (sub === "add") {
          // Bare `/provider add` is the guided connect (same as /login):
          // provider → key/baseUrl → live fetch → model chooser.
          const id = (rest[0] ?? "").toLowerCase()
          if (!id) {
            startLogin()
            break
          }
          const entry = getCatalogEntry(id)
          if (!entry) {
            addSystemMessage(
              `Usage: /provider add <id> <apikey> [baseUrl]\nIds: ${PROVIDER_CATALOG.map((e) => e.id).join(", ")}`,
            )
          } else {
            const key = cleanApiKey(rest[1] ?? "")
            const base = rest[2] ?? entry.defaultBaseUrl
            if (entry.needsApiKey && !key) {
              addSystemMessage(
                `/${entry.id} needs an API key: /provider add ${entry.id} <apikey>${entry.needsBaseUrl ? " [baseUrl]" : ""} — or /provider add for the guided flow.`,
              )
            } else {
              addSystemMessage(`Fetching models for ${entry.label}…`, { persist: false, ttlMs: 10_000 })
              void fetchModelsDetailed(entry.id, base, key).then((res) => {
                const { models, tag } = resolveModels(entry.id, res)
                if (models.length === 0) {
                  // No listable models and no default (custom endpoint
                  // without /v1/models): stay switched, ask for an explicit
                  // id like VS Code's custom provider config.
                  applyProviderSwitch(entry.id, "", base, key, [])
                  hideLoginRows()
                  setLoginFlow({ stage: "model", providerId: entry.id, baseUrl: base, apiKey: key, models: [] })
                  addLoginRow(`${g("ok")} ${entry.label} connected at ${base} — type the exact model id to use.`, {
                    persist: false,
                    ttlMs: 0,
                  })
                  return
                }
                // Switch first (no model flash), then open the chooser so the
                // user picks directly instead of reading a text dump.
                applyProviderSwitch(entry.id, models[0] ?? entry.defaultModel, base, key, models)
                setShowModelPicker(/*showModelPicker*/ true)
                addSystemMessage(
                  `${g("ok")} ${entry.label} connected · choose in the picker ↑↓ Enter (${models.length} ${tag}). Esc keeps ${models[0] ?? entry.defaultModel}.`,
                  { persist: false, ttlMs: 10_000 },
                )
              })
            }
          }
        } else if (sub === "key") {
          // API keys live inside /provider now: view / set / verify per
          // backend. Values are never printed — only ✓/length. Every set is
          // verified with a 1-token chat ping (listing can succeed while
          // chat 401s, e.g. an HF read-only token).
          const cfgKey = loadConfig()
          const keyIdRaw = (rest[0] ?? "").toLowerCase()
          const looksLikeKey = (s: string): boolean => s.length >= 8 && !getCatalogEntry(s)
          if (rest.length === 0) {
            const lines = PROVIDER_CATALOG.map((e) => {
              const active = (cfgKey.provider ?? "nvidia").toLowerCase() === e.id ? `${g("dot")} ` : "  "
              const stored =
                readStoredKey(e.id).apiKey || ((cfgKey.provider ?? "").toLowerCase() === e.id ? cfgKey.apiKey : "")
              return `${active}${e.label} (${e.id}) — ${stored ? `key ${g("ok")} (${stored.length} chars)` : "no key"}`
            })
            addSystemMessage(
              `API keys (values never shown):\n${lines.join("\n")}\n\n/provider key <apikey> — set for active · /provider key <id> <apikey> [baseUrl]`,
            )
          } else {
            let id = (cfgKey.provider ?? "nvidia").toLowerCase()
            let rawKey: string
            let base: string | undefined
            if (keyIdRaw && !looksLikeKey(rest[0] ?? "")) {
              const entry = getCatalogEntry(keyIdRaw)
              if (!entry) {
                addSystemMessage(`Unknown provider "${rest[0]}". Ids: ${PROVIDER_CATALOG.map((e) => e.id).join(", ")}`)
                return
              }
              id = entry.id
              rawKey = rest[1] ?? ""
              base = rest[2]
              if (!rawKey) {
                addSystemMessage(`Usage: /provider key ${id} <apikey> [baseUrl]`)
                return
              }
            } else {
              rawKey = rest[0] ?? ""
              base = rest[1]
            }
            const entry = getCatalogEntry(id)
            const key = cleanApiKey(rawKey)
            const effBase =
              base ??
              readStoredKey(id).baseUrl ??
              ((cfgKey.provider ?? "").toLowerCase() === id ? cfgKey.baseUrl : "") ??
              entry?.defaultBaseUrl ??
              ""
            const model =
              ((cfgKey.provider ?? "").toLowerCase() === id ? cfgKey.model : "") || entry?.defaultModel || ""
            addSystemMessage(`Checking key on ${entry?.label ?? id} (1-token chat ping)…`, { persist: false })
            void verifyProviderKey(id, effBase, key, model).then((check) => {
              writeStoredKey(id, key, effBase || entry?.defaultBaseUrl || "")
              if ((cfgKey.provider ?? "").toLowerCase() === id) {
                saveConfig({ apiKey: key, ...(effBase ? { baseUrl: effBase } : {}) })
                agentConfigRef.current = {
                  ...(agentConfigRef.current ?? createAgentConfig(config ?? {})),
                  apiKey: key,
                  ...(effBase ? { baseUrl: effBase } : {}),
                }
                agentRef.current = null
              }
              addSystemMessage(
                check.ok
                  ? `${g("ok")} Key works on ${entry?.label ?? id} (chat ping ${check.status}). Saved — switching back here later reuses it.`
                  : `${g("warn")} Key REJECTED on ${entry?.label ?? id}${check.status ? ` (HTTP ${check.status})` : ""} — saved anyway for retry.\n${check.hint ?? "Check the key and endpoint."}`,
                { ttlMs: 10_000 },
              )
            })
          }
        } else if (sub === "remove") {
          saveConfig({ apiKey: "" })
          agentConfigRef.current = { ...(agentConfigRef.current ?? createAgentConfig(config ?? {})), apiKey: "" }
          agentRef.current = null
          addSystemMessage("Active API key cleared. Run /provider add to reconnect.")
        } else {
          addSystemMessage(
            "Usage: /provider · /provider use <id> [model] · /provider add [<id> <apikey> [baseUrl]] · /provider key [[id] <apikey>] · /provider models [id] · /provider list all · /provider remove",
          )
        }
        break
      }
      case "bubble":
        addSystemMessage("Bubble render mode toggled. Re-rendering last response...")
        break
      case "diff": {
        // Real unified diff (codex diff_render port): bare = working tree,
        // `/diff <path>` = that file. Rendered with +/- per-hunk numbers,
        // capped — read-only git, never writes.
        const target = args.trim()
        try {
          const cwd = config?.cwd ?? process.cwd()
          const stat = execFileSync("git", target ? ["diff", "--stat", "--", target] : ["diff", "--stat"], {
            cwd,
            timeout: 15000,
            encoding: "utf8",
            maxBuffer: 1_048_576,
          } as never).trim()
          if (!stat) {
            addSystemMessage(target ? `No changes to ${target}.` : "Working tree clean — no changes to show.")
            break
          }
          const raw = execFileSync("git", target ? ["diff", "--", target] : ["diff"], {
            cwd,
            timeout: 15000,
            encoding: "utf8",
            maxBuffer: 2_097_152,
          } as never).slice(0, 40_000)
          const files = parseUnifiedDiff(raw)
          const fileCount = files.length
          addSystemMessage(
            `Diff${target ? ` for ${target}` : ""} (${fileCount} file${fileCount === 1 ? "" : "s"}):\n${renderDiffFiles(files, { maxRows: 80 }).join("\n")}`,
          )
        } catch {
          addSystemMessage("No git diff available (not a repo, or git is missing).")
        }
        break
      }
      case "code":
      case "md": {
        const msg = messages.length > 0 ? messages[messages.length - 1] : null
        if (msg) {
          addSystemMessage(`${msg.role} message:\n${msg.content ?? "(no content)"}`)
        } else {
          addSystemMessage("No message to show.")
        }
        break
      }
      case "sessions":
      case "resume":
        setShowPicker(/*showPicker*/ true)
        return
      case "newchat":
        setShowPicker(/*showPicker*/ false)
        sessionIdRef.current = null
        currentSessionRef.current = null
        setMessages([])
        setStaticEpoch((e) => e + 1)
        // Same routing reset as /clear (see above): stale cards belong to
        // the old session.
        subagentRoutingRef.current.clear()
        addSystemMessage("New conversation started.", { persist: false })
        break
      case "theme": {
        if (args) {
          const matched = applyTrayambakTheme(args)
          if (matched) {
            addSystemMessage(`Theme switched to ${matched.name}.`)
          } else {
            addSystemMessage(`Unknown theme "${args}". Run /themes to see available options.`)
          }
        } else {
          setShowThemePicker(/*showThemePicker*/ true)
        }
        return
      }
      case "themes": {
        const allThemes = getTrayambakThemes()
        // Live theme (not boot config): after an in-session /theme switch
        // the dot sat on the old boot theme.
        const liveName = getLiveTheme().name
        const current = allThemes.find((t: TrayambakTheme) => t.name === liveName)
        const list = allThemes
          .map(
            (t: TrayambakTheme) => `  ${t === current ? `${g("dot")} ` : "  "}${t.name} (${t.dark ? "dark" : "light"})`,
          )
          .join("\n")
        addSystemMessage(`Available themes:\n${list}`)
        break
      }
      case "history":
        addSystemMessage(
          `Session: ${currentSessionRef.current?.sessionName ?? "New conversation"}\nMessages: ${messages.length}\nStarted: ${currentSessionRef.current?.startedAt ?? new Date().toISOString()}`,
        )
        break
      case "copy": {
        const scope = /^last\b/i.test(args.trim()) ? ("last" as const) : ("all" as const)
        const text = formatTranscript(messages, scope)
        if (!text) {
          addSystemMessage("Nothing to copy yet.")
          break
        }
        void copyTextToClipboard(text)
          .then(() =>
            addSystemMessage(
              `${g("ok")} Copied ${text.length} characters (${scope === "last" ? "last reply" : "transcript"}) to the clipboard.`,
              { ttlMs: 10_000 },
            ),
          )
          .catch((error) =>
            addSystemMessage(`${g("warn")} Copy failed: ${error instanceof Error ? error.message : String(error)}`, {
              ttlMs: 10_000,
            }),
          )
        break
      }
      case "stats":
        addSystemMessage(`Token count: ${tokenCount}\nMessage count: ${messages.length}`)
        break
      case "skills":
        {
          const profiles = listAgentProfiles()
          if (profiles.length === 0) {
            addSystemMessage("No agent profiles found.")
          } else {
            addSystemMessage(profiles.map((p) => `- ${p.id} [${p.category}] ${p.name}: ${p.description}`).join("\n"))
          }
        }
        break
      case "todo":
        slashCommandService
          .dispatch(`/todo ${args}`.trim())
          .then((output) => addSystemMessage(output, { ttlMs: 10_000 }))
          .catch((error) =>
            addSystemMessage(`/todo failed: ${error instanceof Error ? error.message : String(error)}`, {
              ttlMs: 10_000,
            }),
          )
        break
      case "memory": {
        // Real persistent store (USEMEMORY.MD via the memory tool layer) —
        // previously this counted system rows, which was simply wrong.
        const entries = loadMemory()
        const auto = loadConfig().memoryAutoExtract !== false ? "on" : "off"
        if (entries.length === 0) {
          addSystemMessage(
            `No persistent memory entries yet. Auto-extract ${auto} (memoryAutoExtract in config). Say "remember that…" or use the memory tool.`,
          )
        } else {
          const shown = entries
            .slice(-15)
            .map((e) => `- [${e.category ?? "context"}] ${e.content.slice(0, 120)}`)
            .join("\n")
          addSystemMessage(
            `Persistent memory (${entries.length}, auto-extract ${auto}):\n${shown}${entries.length > 15 ? `\n…+${entries.length - 15} more` : ""}`,
          )
        }
        break
      }
      case "search": {
        // QUICK_SEARCH port: grep this session's transcript. The composer
        // stays yours — results land as one system row, nothing persisted.
        const q = args.trim().toLowerCase()
        if (!q) {
          addSystemMessage("Usage: /search <text> — grep this session's transcript.")
          break
        }
        const hits: string[] = []
        for (const m of messages) {
          const idx = (m.content ?? "").toLowerCase().indexOf(q)
          if (idx >= 0) {
            const snippet = (m.content ?? "").slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, " ")
            hits.push(`[${m.role}] …${snippet}…`)
            if (hits.length >= 10) break
          }
        }
        addSystemMessage(
          hits.length > 0
            ? `Transcript matches for "${args.trim()}" (${hits.length}${hits.length >= 10 ? "+" : ""}):\n${hits.join("\n")}`
            : `No transcript matches for "${args.trim()}".`,
        )
        break
      }
      case "fork": {
        // FORK_SUBAGENT port (local only): fire-and-forget background
        // subagent inheriting the current turn's context, parent keeps the
        // composer. No recursion guard needed: background jobs have no
        // composer/slash path, so a fork child cannot /fork.
        // Context is codex-style (recent turns, capped) rather than just the
        // last prompt, so the child starts oriented.
        const directive = args.trim()
        if (!directive) {
          addSystemMessage(
            "Usage: /fork <directive> — background subagent with this turn's context (see it under /background).",
          )
          break
        }
        const tail = messages
          .filter((m) => (m.role === "user" || m.role === "assistant") && (m.content ?? "").trim().length > 0)
          .slice(-6)
          .map(
            (m) =>
              `${m.role === "user" ? "User" : "Assistant"}: ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 400)}`,
          )
          .join("\n")
        const context = tail.length > 0 ? `Recent conversation:\n${tail.slice(0, 2400)}\n` : ""
        void launchSubagent(
          "general",
          `${context}Fork directive (work autonomously): ${directive}`,
          /*background*/ true,
        )
        break
      }
      case "cron": {
        // Cron job visibility: create/delete stay model tools
        // (trayambak__CronCreate/Delete); due jobs fire on the 60s scheduler.
        const jobs = listCronJobs()
        if (jobs.length === 0) {
          addSystemMessage(
            "No cron jobs scheduled. The model can create them with trayambak__CronCreate (5-field cron + prompt).",
          )
        } else {
          const lines = jobs.map((j) => {
            const waitMin = Math.max(0, Math.round((j.nextFireAt - Date.now()) / 60_000))
            return `- ${j.id} [${j.cron}]${j.recurring ? "" : " (once)"} fires in ~${waitMin}m: ${j.prompt.slice(0, 80)}`
          })
          addSystemMessage(`Cron jobs (${jobs.length}, 60s scheduler):\n${lines.join("\n")}`)
        }
        break
      }
      case "background":
        setPanelInitialTab("background")
        setShowSubagentPanel(/*showSubagentPanel*/ true)
        setTaskHint(null)
        break
      case "forget":
        if (args === "confirm") {
          if (sessionIdRef.current) {
            deleteSession(sessionIdRef.current)
          }
          setMessages([])
          setStaticEpoch((e) => e + 1)
          sessionIdRef.current = null
          currentSessionRef.current = null
          addSystemMessage("Session history cleared.")
        } else {
          addSystemMessage("Type /forget confirm to clear the session history.")
        }
        break
      case "goal": {
        // `args` is the raw tail string (runSlash passes a string, not
        // tokens) — split it instead of casting it to an array.
        const tokens = args.split(/\s+/).filter(Boolean)
        const goal = tokens[0] ?? "show"
        if (goal === "set") addSystemMessage(`Goal set: ${tokens.slice(1).join(" ")}`)
        else if (goal === "clear") addSystemMessage("Goal cleared.")
        else addSystemMessage("Goal management: /goal <set|show|clear> <text>")
        break
      }
      case "refine": {
        addSystemMessage("Refining last response with self-improvement lessons...")
        break
      }
      case "expand": {
        addSystemMessage("Expanding last tool result to full view...")
        break
      }
      case "mcp": {
        // Implemented in mcp-command.ts: list/search/install/add/remove/test
        // against the connector registry + live servers. Every accepted
        // change persists and rebuilds the agent — no restart needed.
        runMcp(args, {
          addSystemMessage,
          agentConfigRef,
          agentRef,
          config: config ?? null,
        })
        break
      }
      case "devmode": {
        // Bare /devmode toggles ON<->OFF; turning ON opens the pentest
        // enable/disable menu (the "gate" line in it is the /gate state).
        // Every write persists to config AND patches agentConfigRef + null
        // agentRef, so the next message rebuilds the agent with the new
        // toolsets/engine flags — no restart needed.
        //
        // Implemented in devmode-command.ts: this file was over the
        // max-file-size cap and the handler is self-contained.
        runDevmode(args, {
          addSystemMessage,
          setPendingQuestion,
          questionResolverRef,
          agentConfigRef,
          agentRef,
          config: config ?? null,
        })
        break
      }
      case "commands": {
        const custom = promptCommands.length
          ? `Custom prompt files (${promptCommands.length}):\n` +
            promptCommands
              .map((c) => {
                const short = c.file.startsWith(process.cwd()) ? c.file.slice(process.cwd().length + 1) : c.file
                return `  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}  (${short})`
              })
              .join("\n")
          : "Custom prompt files: none — drop .md files into ./commands/, ./.trayambak/commands/ or ~/.trayambak/commands/"
        addSystemMessage(
          `Slash commands: ${SLASH_COMMANDS.length} built-in + ${slashCommandService.registry.all().length} dispatched (agent, task, todo, plan, manager, compact, mode, worktree).\n${custom}`,
        )
        break
      }
      case "doctor":
        addSystemMessage(
          `Diagnostic info:\nCWD: ${config?.cwd ?? process.cwd()}\nModel: ${activeModel}\nTheme: ${config?.themeName ?? "default"}`,
        )
        break
      case "question": {
        const num = parseInt(args, 10)
        if (!isNaN(num) && num >= 1 && num <= 9) {
          questionDefaultOptionRef.current = num
          addSystemMessage(`Default question option set to ${num}.`)
        } else if (args === "both" || args === "choose" || args === "type") {
          questionAnswerModeRef.current = args
          addSystemMessage(`Question answer mode set to "${args}".`)
        } else {
          addSystemMessage(
            `Usage: /question <number (1-9)> | both | choose | type\n  Current: default=${questionDefaultOptionRef.current}, mode=${questionAnswerModeRef.current}`,
          )
        }
        break
      }
      case "subagents":
        setPanelInitialTab("all")
        setShowSubagentPanel(/*showSubagentPanel*/ true)
        setTaskHint(null)
        break
      case "agent": {
        const rest = args.trim()
        if (!rest) {
          setShowAgentPicker(/*showAgentPicker*/ true)
          return
        }
        const parts = rest.split(/\s+/)
        const verb = (parts[0] ?? "").toLowerCase()
        const tail = parts.slice(1)
        if (verb === "list") {
          const profiles = listAgentProfiles()
          addSystemMessage(
            profiles.length === 0
              ? "No custom agent profiles found (builtins: general, explore, plan, coder, browser, planner)."
              : profiles.map((p) => `- ${p.name} [${p.category}] ${p.description}`).join("\n"),
          )
          break
        }
        if (verb === "info") {
          const type = (tail[0] ?? "").toLowerCase()
          const profile = listAgentProfiles().find((p) => p.name.toLowerCase() === type || p.id.toLowerCase() === type)
          addSystemMessage(
            profile
              ? `Agent: ${profile.name}\nCategory: ${profile.category}\nDescription: ${profile.description}\nFile: ${profile.id}`
              : type
                ? `Agent profile not found: ${type}`
                : "Usage: /agent info <type>",
          )
          break
        }
        if (verb === "run" || verb === "runbg") {
          let background = verb === "runbg"
          let restParts = tail
          if (restParts[0] === "--bg") {
            background = true
            restParts = restParts.slice(1)
          }
          const type = restParts[0]
          const prompt = restParts.slice(1).join(" ").trim()
          if (!type || !prompt) {
            addSystemMessage(
              "Usage: /agent run [--bg] <type> <prompt>  ·  /agent (picker)  ·  /agent list  ·  /agent info <type>",
            )
            break
          }
          void launchSubagent(type, prompt, background)
          break
        }
        addSystemMessage("Usage: /agent [picker] | list | info <type> | run [--bg] <type> <prompt>")
        break
      }
      case "review": {
        // opencode /review port: submit a review turn — the agent collects
        // the diff, reads full files, and runs trayambak__ParallelReview.
        // Bare = working tree; `commit <sha>` = git show; `branch <name>` =
        // triple-dot diff. Submitted via handleInput so queueing works.
        handleInput(buildReviewPrompt(args))
        break
      }
      case "init": {
        // opencode /init port: scan the repo and write/update AGENTS.md +
        // durable memory. One turn, scoped — no unrelated work.
        handleInput(buildInitPrompt())
        break
      }
      case "retry": {
        if (pendingQuestion !== null || waitingCustom || pendingAgentTypeRef.current) {
          addSystemMessage("Answer the pending question first — /retry needs a free composer.")
          break
        }
        const last = lastUserPromptRef.current
        if (!last) {
          addSystemMessage("Nothing to retry — no prompt sent yet.")
          break
        }
        addSystemMessage(
          `↻ Retrying: ${last.slice(0, 80)}${last.length > 80 ? "…" : ""}  (Ctrl+R loads it into the composer to edit instead)`,
        )
        handleInput(last)
        break
      }
      default:
        slashCommandService
          .dispatch(`/${command} ${args}`.trim())
          .then((output) => {
            addSystemMessage(output, { ttlMs: 10_000 })
          })
          .catch((error) => {
            addSystemMessage(`Command failed: ${error instanceof Error ? error.message : String(error)}`, {
              ttlMs: 10_000,
            })
          })
    }
  }

  /** Slash entry wrapper: snaps to live first — a slash is new activity, so
   *  its TTL'd readout (see addSystemMessage) must land in-frame even if the
   *  user was parked reading history. */
  const runSlash = (command: string, args: string): void => {
    setScrollBack(0)
    handleSlashCommand(command, args)
  }

  const handleChoose = (command: string, value: string): void => {
    runSlash(command, value)
  }

  /** Push the live UI mode into the agent's permission config so the
   * engine (deny rules, read-only mode, hidden tools) sees it too — and
   * persist it to the user config so the next launch boots into the same
   * mode instead of silently resetting to ASK. Manual merge (saveConfig is
   * shallow — a bare {permissions:{uiMode}} would wipe saved rulesV2). */
  const syncUiMode = (mode: PermissionMode): void => {
    permissionModeRef.current = mode
    if (agentRef.current) {
      agentRef.current.config.permissions = {
        ...agentRef.current.config.permissions,
        uiMode: mode,
      }
    }
    try {
      const cfg = loadConfig()
      const perms = cfg.permissions ?? {}
      saveConfig({ permissions: { ...perms, uiMode: mode } })
    } catch (err) {
      addSystemMessage(
        `Couldn't persist permission mode (${err instanceof Error ? err.message : String(err)}) — it resets to ASK next launch.`,
      )
    }
  }

  /** Resolve a queued permission decision by row id (SKT AI LABS-style queue:
   * each row owns its own resolver, so parallel requests never clobber). */
  const resolvePermission = (id: string, approved: boolean): void => {
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id))
    const idx = resolverQueueRef.current.findIndex((r) => r.id === id)
    if (idx >= 0) {
      const [entry] = resolverQueueRef.current.splice(idx, 1)
      entry.resolve(approved)
      // The approval prompt set status "idle" while it waited (line ~774)
      // but never restored it — isStreaming stayed true, so after the user
      // answered the footer read "● idle" while ⠴ Thinking… spun forever
      // ("yet its stucks"). The agent just resumed: say "running" again;
      // turn_end / the next event re-derives the real state from here.
      setStatus("running")
    }
  }

  /** Orphan sweep: a turn can end (abort / Ctrl+D / error) while a
   *  permission or question dialog is still awaited — the agent unwound but
   *  the rows stay: the overlay keeps owning y/n/Enter (empty composer),
   *  so the dialog lingers forever over a dead turn ("stuck box"). Deny is
   *  the safe default for orphaned permissions.
   *
   *  Permission resolvers drain UNCONDITIONALLY now: the old bgAlive skip
   *  left foreground orphans stuck (composer disabled) for the whole
   *  lifetime of any background job. That skip was overcautious — children
   *  run with askByDefault:false, so background approvals effectively never
   *  enter this queue. The sweep still spares a live QUESTION while
   *  background jobs run (a background AskUserQuestion surfaces as a
   *  foreground question row that must outlive the main turn). */
  const sweepOrphanedDialogs = (): void => {
    const orphans = resolverQueueRef.current.splice(0, resolverQueueRef.current.length)
    if (orphans.length > 0) {
      for (const entry of orphans) entry.resolve(/*value*/ false)
      setPendingPermissions([])
      addSystemMessage(
        `${g("ok")} Cleared ${orphans.length} unanswered permission request(s) from the finished turn — resend the message to retry.`,
      )
    }
    const bgAlive = Array.from(backgroundSubagents.values()).some((j) => j.status === "running")
    if (bgAlive) return
    if (questionResolverRef.current) {
      const resolve = questionResolverRef.current
      questionResolverRef.current = null
      setPendingQuestion(null)
      setWaitingCustom(/*waitingCustom*/ false)
      resolve([])
    }
  }

  /** Persist an allow/deny rule for this tool+subject to the user config,
   * mirror it onto the live agent config, then resolve the request. */
  const persistAndResolve = (id: string, action: "allow" | "deny"): void => {
    const row = pendingPermissions.find((p) => p.id === id)
    if (!row) {
      resolvePermission(id, action === "allow")
      return
    }
    const pattern = permissionSubject(row.args)
    const rule = { tool: row.tool, pattern, action, reason: "user choice from permission overlay" }
    try {
      const cfg = loadConfig()
      const perms = cfg.permissions ?? {}
      saveConfig({
        permissions: { ...perms, rulesV2: [...(perms.rulesV2 ?? []), rule] },
      })
      if (agentRef.current) {
        const live = agentRef.current.config.permissions ?? {}
        agentRef.current.config.permissions = { ...live, rulesV2: [...(live.rulesV2 ?? []), rule] }
      }
      addSystemMessage(
        `${action === "allow" ? `${g("ok")} Always allow` : `${g("fail")} Never allow`} saved: ${row.tool} → ${pattern}`,
      )
    } catch (err) {
      addSystemMessage(`Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}`)
    }
    resolvePermission(id, action === "allow")
  }

  const togglePermissionMode = (): void => {
    const prev = { current: permissionModeRef.current, stack: modeStackRef.current }
    const next = cycleMode(prev)
    modeStackRef.current = next.stack
    setPermissionMode(next.current)
    // Was missing: the cycled mode never reached the live agent config
    // (only the per-turn mirror did) and never persisted — Ctrl+K P felt
    // lossy compared to /mode. syncUiMode does all three.
    syncUiMode(next.current)
    if (next.current === "plan") {
      addSystemMessage(
        `${g("warn")} Plan mode ON — mutating tools are denied; ask the model for a plan, then cycle modes to execute it.`,
        { ttlMs: 10_000 },
      )
    } else if (prev.current === "plan") {
      addSystemMessage("Plan mode OFF — mutating tools are available again.", { ttlMs: 10_000 })
    }
  }

  /** Shift-Tab: enter plan mode (restores the previous mode on exit),
   *  or leave it back to exactly where you came from. Same stack +
   *  persistence as /mode and the Ctrl+K P cycle. */
  const togglePlanMode = (): void => {
    const prev = { current: permissionModeRef.current, stack: modeStackRef.current }
    const next = prev.current === "plan" ? exitMode(prev) : enterMode(prev, "plan")
    modeStackRef.current = next.stack
    setPermissionMode(next.current)
    syncUiMode(next.current)
    if (next.current === "plan") {
      addSystemMessage(
        `${g("warn")} Plan mode ON — mutating tools are denied; ask the model for a plan, then Shift-Tab again to execute it.`,
        { ttlMs: 10_000 },
      )
    } else {
      addSystemMessage("Plan mode OFF — mutating tools are available again.", { ttlMs: 10_000 })
    }
  }

  /** Ctrl-C on an empty composer (PromptInput delegates here): deny open
   *  dialogs, abort a live turn, or arm/exit on idle double-press. Mirrors
   *  the /exit path (abort + sweep + onExit) on the killing press. */
  const handleCtrlCEmpty = (): void => {
    const action = resolveCtrlCPress({
      running: isRunningRef.current,
      hasDraft: false,
      dialogOpen: pendingPermissions.length > 0 || pendingQuestion !== null || waitingCustom,
      lastPressAtMs: lastCtrlCRef.current,
    })
    if (action === "deny-dialog") {
      for (const p of pendingPermissions) resolvePermission(p.id, /*approved*/ false)
      if (pendingQuestion !== null || waitingCustom) {
        setPendingQuestion(null)
        setWaitingCustom(/*waitingCustom*/ false)
        questionResolverRef.current?.([])
        questionResolverRef.current = null
        addSystemMessage("Question dismissed (Ctrl-C).", { persist: false })
      }
      return
    }
    if (action === "abort") {
      abortControllerRef.current?.abort()
      sweepOrphanedDialogs()
      return
    }
    if (action === "exit") {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current)
        ctrlCTimerRef.current = null
      }
      lastCtrlCRef.current = 0
      setTaskHint(null)
      abortControllerRef.current?.abort()
      sweepOrphanedDialogs()
      onExit?.()
      return
    }
    lastCtrlCRef.current = Date.now()
    setTaskHint(`Press Ctrl+C again within ${Math.round(CTRL_C_EXIT_WINDOW_MS / 1000)}s to exit`)
    if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current)
    ctrlCTimerRef.current = setTimeout(() => {
      lastCtrlCRef.current = 0
      ctrlCTimerRef.current = null
      setTaskHint((prev) => (prev !== null && prev.startsWith("Press Ctrl+C") ? null : prev))
    }, CTRL_C_EXIT_WINDOW_MS + 500)
  }

  /** Ctrl-S inject: park the draft at the FRONT of the prompt queue (ahead
   *  of Enter-queued prompts) so it runs next; idle turns just run it.
   *  Refuses while questions/agents/overlays own the composer. */
  const handleInject = (draft: string): void => {
    const text = draft.trim()
    if (!text) return
    if (pendingQuestion !== null || waitingCustom || pendingAgentTypeRef.current) {
      addSystemMessage("Answer the pending prompt first — inject needs a free composer.", { persist: false })
      return
    }
    lastUserPromptRef.current = text
    if (isRunningRef.current || isLoading) {
      queueRef.current.unshift(text)
      setQueuedPrompts([...queueRef.current])
      const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text
      addSystemMessage(`⏩ Injected to front of queue: ${shown}`)
    } else {
      void runAgent(text).catch(reportTurnError)
    }
  }

  useAppInput((input, key) => {
    debugInputLog(
      `in=${JSON.stringify(input)} return=${String(key.return)} ctrl=${String(key.ctrl)} esc=${String(key.escape)} raw=${String(process.stdin.isRaw)} tty=${String(process.stdin.isTTY)}`,
    )
    // Overlay-aware hotkeys: while an overlay is open its component owns the
    // input — global chords would fire side effects behind the overlay.
    // Ctrl+D stays unguarded: aborting a turn is an emergency action.
    const overlayOpen =
      showBootCine ||
      showSplash ||
      showSandboxSetup ||
      showThemePicker ||
      showPalette ||
      showModelPicker ||
      showProviderPicker ||
      showWhichKey ||
      showSubagentPanel ||
      showAgentPicker ||
      showPicker ||
      pendingPermissions.length > 0 ||
      pendingQuestion !== null
    if (key.ctrl && input === "z" && !overlayOpen) {
      undoCheckpoint()
    }
    if (key.ctrl && input === "y" && !overlayOpen) {
      redoCheckpoint()
    }
    if (key.ctrl && input === "x" && !overlayOpen) {
      const n = queueRef.current.length
      if (n > 0) {
        queueRef.current = []
        setQueuedPrompts([])
        addSystemMessage(`Cleared ${n} queued prompt${n === 1 ? "" : "s"}.`)
      }
    }
    if (key.ctrl && input === "d") {
      abortControllerRef.current?.abort()
      // Unblock a turn parked inside `await onRequestPermission`: aborting
      // the controller alone never resolves the permission promise, so
      // agent.run() hung and `finally` (which sweeps) was never reached —
      // stuck overlay until manual y/n. Deny-by-default is the safe wake.
      sweepOrphanedDialogs()
    }
    if (key.ctrl && input === "p" && !overlayOpen) {
      // SKT AI LABS parity: ctrl+p opens the command palette; the permission-mode
      // cycle remains on Ctrl+K P (leader table).
      setShowPalette(/*showPalette*/ true)
    }
    if (key.ctrl && input === "g" && !overlayOpen) {
      // Subagents panel lives here now: Ctrl+S became inject-mid-stream,
      // so the panel moved one key right (still in /keymap + which-key).
      setPanelInitialTab("all")
      setShowSubagentPanel(/*showSubagentPanel*/ true)
      setTaskHint(null)
    }
    if (key.ctrl && input === "o" && !overlayOpen) {
      // Collapse / expand tool output + compaction summaries. Transcript-
      // clean: the state rides the footer hint, never the log.
      setExpandOutput((prev) => {
        const next = !prev
        setTaskHint(next ? "Output expanded — Ctrl+O to collapse" : null)
        return next
      })
    }
    if ((key.tab && key.shift) || input === "[Z") {
      // Shift-Tab toggles plan mode (single atomic emit — see useAppInput).
      // Overlay-guarded like the other chords: pickers own their keys.
      if (!overlayOpen) togglePlanMode()
    }
    if (key.ctrl && input === "b" && !overlayOpen) {
      setPanelInitialTab("background")
      setShowSubagentPanel(/*showSubagentPanel*/ true)
      setTaskHint(null)
    }
    if (key.ctrl && input === "k" && !overlayOpen) {
      setShowWhichKey(/*showWhichKey*/ true)
    }
    // Esc cancels a mid-flight provider connect (typed key/model steps).
    // Picker overlays own their own Esc (they stand down the composer), and
    // permission/question dialogs own theirs — never steal those.
    if (
      key.escape &&
      loginFlowRef.current &&
      !showProviderPicker &&
      !showModelPicker &&
      pendingPermissions.length === 0 &&
      pendingQuestion === null
    ) {
      cancelLogin()
    }
  })

  /** Root-frame height: Ink only ever does `rootNode.yogaNode.setWidth(terminalWidth)`
   *  (ink.js:321) — never setHeight — so the root Box's `height="100%"` resolved
   *  against an undefined parent and fell back to content height. Symptom: the
   *  frame widened on both sides when the terminal widened, but its bottom edge
   *  never followed the terminal downward ("width increases both sides, only
   *  grows straight, not towards the bottom"). Explicit rows from the live window
   *  size also re-render on resize, so the border tracks terminal height both ways. */
  const rows = useTerminalRows()

  const statusBarInfo: StatusBarInfo = {
    model: activeModel,
    permissionMode,
    status,
    statusBarText: activeModel,
    tokenCount: tokenCount || undefined,
    contextWindow: bootConfig.contextWindow ?? config?.contextWindow,
    isStreaming,
    queuedCount: queuedPrompts.length,
    backgroundCount: backgroundSubagents.size,
    taskHint: taskHint ?? undefined,
  }

  useEffect(() => {
    if (initialPrompt && !isLoading) {
      void runAgent(initialPrompt.trim()).catch(reportTurnError)
    }
  }, [initialPrompt])

  useEffect(() => {
    const count = messages.reduce((sum, msg) => sum + Math.ceil((msg.content ?? "").length / 4), 0)
    setTokenCount(count)
  }, [messages])

  // Latest-turn runner for the cron scheduler below: runAgent closes over
  // per-render state (messages, activeModel), so the 60s interval must call
  // through a ref or kicked turns would run with stale context.
  const runAgentRef = useRef(runAgent)
  runAgentRef.current = runAgent

  // Cron scheduler (hermes cron/scheduler.py port, in-process): model-created
  // jobs via trayambak__CronCreate actually fire here. The 60s tick reaps due
  // jobs; fired prompts join the normal prompt queue (same permission
  // overlays as typed prompts) and kick an idle turn. Previously
  // tickCronJobs had zero callers — jobs were write-only.
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        tickCronJobs(async (job) => {
          const stamped = `[cron ${job.id}] ${job.prompt}`
          queueRef.current.push(stamped)
          setQueuedPrompts([...queueRef.current])
          addSystemMessage(`⏰ Cron fired (${job.recurring ? "recurring" : "one-shot"}): ${job.prompt.slice(0, 120)}`, {
            persist: false,
          })
          if (!isRunningRef.current) {
            const next = queueRef.current.shift()
            setQueuedPrompts([...queueRef.current])
            if (next !== undefined) void runAgentRef.current(next).catch(reportTurnError)
          }
        })
      } catch {
        /* the scheduler never breaks the TUI */
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, [])

  // Sidebar todos: refresh when the sidebar opens or the conversation moves
  // (slash `/todo` runs land in messages, so this picks them up).
  useEffect(() => {
    if (!showSidebar) return
    setSidebarTodos(todoListForSession(sessionIdRef.current ?? undefined))
  }, [showSidebar, messages.length])

  // Terminal activity notifications (OSC 0 title + bell + OSC 9 OSD) and the
  // live title animation. While a turn is running the tab spins so several
  // terminals are told apart at a glance; when it settles the title returns to
  // the static activity form (approval/error/input still override it).
  const lastActivityRef = useRef(0)
  useEffect(() => {
    if (isLoading || isStreaming) {
      void notifyTerminalActivity({ activity: "working" })
      startTitleAnimation({ backgroundCount: bgRunningCount })
      return
    }
    stopTitleAnimation()
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant") return
    const now = Date.now()
    if (now - lastActivityRef.current < 3000) return
    lastActivityRef.current = now
    void notifyTerminalActivity({ activity: "idle" })
  }, [messages, isLoading, isStreaming, bgRunningCount])

  // Never leave a spinner running past unmount (exit path / hot reload).
  useEffect(() => () => stopTitleAnimation(), [])

  const prevBgRunningRef = useRef(bgRunningCount > 0)
  useEffect(() => {
    const prev = prevBgRunningRef.current
    const now = bgRunningCount > 0
    prevBgRunningRef.current = now
    if (prev && !now) {
      setTaskHint(`${g("ok")} Background task finished — Ctrl+B to view`)
      void notifyTerminalActivity({ activity: "task-done", detail: "Background task finished" })
    }
  }, [bgRunningCount])

  // Questions/permissions need the composer: close any pane-replacing overlay
  // (subagent panel / agent picker / theme picker / session picker) the moment
  // one arrives — PromptInput is unmounted while those are open, so answers
  // could not be typed ("no input" during a pending question).
  useEffect(() => {
    if (pendingQuestion !== null || pendingPermissions.length > 0) {
      setShowSubagentPanel(/*showSubagentPanel*/ false)
      setShowAgentPicker(/*showAgentPicker*/ false)
      setShowThemePicker(/*showThemePicker*/ false)
      setShowWhichKey(/*showWhichKey*/ false)
      setShowPicker(/*showPicker*/ false)
      setShowPalette(/*showPalette*/ false)
      setShowModelPicker(/*showModelPicker*/ false)
    }
  }, [pendingQuestion, pendingPermissions.length])

  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        endSession(sessionIdRef.current)
      }
      onExit?.()
    }
  }, [onExit])

  const bgRunning = bgRunningCount > 0

  /** Leader (Ctrl+K) chord table — rendered by the which-key overlay. */
  /** Fetch the provider's model list (always resolves; realtime per-provider
   *  endpoint). No static padding: a failed endpoint shows the honest empty
   *  state + warn instead of a stale few-row list. */
  const refreshModels = (): void => {
    const cfg = loadConfig()
    const prov = cfg.provider ?? "nvidia"
    void fetchModelsDetailed(prov, cfg.baseUrl, cfg.apiKey).then((res) => {
      const { models } = resolveModels(prov, res)
      setAvailableModels(models)
      if (models.length === 0) {
        addSystemMessage(
          `No models returned by ${providerLabelFor(prov)} — check key/endpoint, then /models retries.${fetchWarn(res.error)}`,
          { persist: false, ttlMs: 10_000 },
        )
      }
    })
  }

  const openModelPicker = (): void => {
    const cfg = loadConfig()
    const entry = getCatalogEntry(cfg.provider ?? "nvidia")
    // Same dead-end guard as /models: a keyless gated backend opens the key
    // prompt, never the 5-row static picker.
    if (entry?.needsApiKey && !cfg.apiKey && availableModels === null) {
      hideLoginRows()
      setLoginFlow({ stage: "apiKey", providerId: entry.id, baseUrl: cfg.baseUrl, apiKey: "", models: null })
      addLoginRow(
        `${g("prompt")} ${entry.label}: no API key saved — paste it (or type 'skip'), and the live model list follows. Esc cancels.`,
        { persist: false, ttlMs: 0 },
      )
      return
    }
    setShowModelPicker(/*showModelPicker*/ true)
    // Refetch when we have nothing OR an empty (earlier failed) list — an
    // empty list must never become a permanent dead picker.
    if (availableModels === null || availableModels.length === 0) refreshModels()
  }

  /** Persist + hot-swap the active provider/model/baseUrl/apiKey in one shot
   *  (used by /login + /provider use). Rebuilds the agent provider on the
   *  next run and refreshes the picker header. Pass keepModels to keep a
   *  freshly fetched list visible in an open ModelPicker (else it resets). */
  const applyProviderSwitch = (
    providerId: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    keepModels?: string[],
  ): void => {
    const entry = getCatalogEntry(providerId)
    // Clean pasted prefixes ("NVAPI_KEY nvapi-…", "Bearer …") at the single
    // choke point — a prefixed key 401s on every provider. An empty key
    // falls back to the backend's stored key so switching never wipes
    // credentials silently.
    const stored = readStoredKey(providerId)
    const effKey = cleanApiKey(apiKey) || stored.apiKey
    const effBase = baseUrl || stored.baseUrl || entry?.defaultBaseUrl || loadConfig().baseUrl
    const effModel = model || entry?.defaultModel || model
    saveConfig({
      provider: providerId as ReturnType<typeof loadConfig>["provider"],
      baseUrl: effBase,
      apiKey: effKey,
      model: effModel,
    })
    // Remember per-backend so switching away and back keeps the key (never
    // overwrite a stored key with an empty one).
    if (effKey) writeStoredKey(providerId, effKey, effBase)
    setProviderInfo({ label: providerLabelFor(providerId), host: providerHostFor(effBase) })
    if (effModel) {
      const nextRecents = pushRecent(modelRecents, effModel)
      saveConfig({ modelRecents: nextRecents })
      setActiveModel(effModel)
      setModelRecents(nextRecents)
    }
    setAvailableModels(keepModels ?? null)
    agentConfigRef.current = {
      ...(agentConfigRef.current ?? createAgentConfig(config ?? {})),
      provider: providerId as ReturnType<typeof loadConfig>["provider"],
      baseUrl: effBase,
      apiKey: effKey,
      model: effModel,
    }
    agentRef.current = null
  }

  /** /login step 1: arrow-key provider chooser (typed number/id still works
   *  as a fallback while the picker is closed). */
  const startLogin = (): void => {
    if (isRunningRef.current || isLoading) {
      addSystemMessage("Finish or abort the running turn first — the provider connect needs a free composer.")
      return
    }
    if (loginFlow) {
      addSystemMessage("Connect already in progress — answer the pending step or press Esc.")
      return
    }
    hideLoginRows() // any stale rows from an abandoned flow
    setLoginFlow({ stage: "provider", providerId: "", baseUrl: "", apiKey: "", models: null })
    setShowProviderPicker(/*showProviderPicker*/ true)
    addLoginRow(`${g("prompt")} Choose a provider ↑↓ Enter (or type its number/id).`, {
      persist: false,
      ttlMs: 0,
    })
  }

  /** Shared fetch → model-chooser step: live model list, then straight into
   *  the ModelPicker (no text dump). Picking completes the switch via
   *  selectModelDuringLogin; Esc leaves a typed number/id fallback. */
  const fetchAndPickModel = async (providerId: string, baseUrl: string, key: string): Promise<void> => {
    const entry = getCatalogEntry(providerId)
    // Clean FIRST: a pasted "NVAPI_KEY nvapi-…" prefix or stray whitespace
    // 401s the fetch below while the later switch would have saved it
    // clean — every "5 fallback with a good key" report traced to this.
    key = cleanApiKey(key)
    // Key-gated backend with no key: fetching would 401 into the tiny
    // static list (the "5 models" dead end) — ask for the key instead.
    if (entry?.needsApiKey && !key) {
      hideLoginRows()
      setLoginFlow({ stage: "apiKey", providerId, baseUrl, apiKey: "", models: null })
      addLoginRow(
        `${g("prompt")} ${entry.label}: no API key saved — paste it (or type 'skip'), and the live model list follows. Esc cancels.`,
        { persist: false, ttlMs: 0 },
      )
      return
    }
    addLoginRow(`Fetching models for ${entry?.label ?? providerId}…`, { persist: false })
    const res = await fetchModelsDetailed(providerId, baseUrl, key)
    const { models: usable, tag } = resolveModels(providerId, res)
    if (usable.length === 0) {
      if (!entry?.defaultModel) {
        // Custom-style endpoint: no listable models and no default — stay
        // in-flow and take an explicitly typed id (VS Code custom style).
        // The key (if any) is still saved by the switch below.
        applyProviderSwitch(providerId, "", baseUrl, key, [])
        hideLoginRows()
        setLoginFlow({ stage: "model", providerId, baseUrl, apiKey: key, models: [] })
        setAvailableModels([])
        addLoginRow(`No model list at ${baseUrl} — type the exact model id to use (Esc cancels).`, {
          persist: false,
          ttlMs: 0,
        })
        return
      }
      applyProviderSwitch(providerId, entry?.defaultModel ?? "", baseUrl, key)
      hideLoginRows() // completed → prompts gone; the ✓ notice below fades on its TTL
      setLoginFlow(null)
      let keyNote = ""
      if (key && entry?.defaultModel) {
        // Prove a freshly entered key instead of landing silent-then-401.
        const check = await verifyProviderKey(providerId, baseUrl, key, entry.defaultModel)
        keyNote = check.ok
          ? " Key works (chat ping ok)."
          : ` Key check FAILED${check.status ? ` (HTTP ${check.status})` : ""}: ${check.hint ?? "check the key."}`
      }
      addSystemMessage(
        `${g("ok")} ${entry?.label ?? providerId} connected (no model list available — using default).${fetchWarn(res.error)}${keyNote}`,
        { ttlMs: 10_000 },
      )
      return
    }
    setProviderInfo({ label: providerLabelFor(providerId), host: providerHostFor(baseUrl) })
    hideLoginRows()
    setLoginFlow({ stage: "model", providerId, baseUrl, apiKey: key, models: usable })
    setAvailableModels(usable)
    setShowModelPicker(/*showModelPicker*/ true)
    addLoginRow(
      `Choose a model in the picker ↑↓ Enter (${usable.length} ${tag} from ${entry?.label ?? providerId}). Esc cancels the whole connect.`,
      { persist: false, ttlMs: 0 },
    )
  }

  /** Shared step 1→2: a chosen backend (picker, typed pick, or /provider use)
   *  routes to Base URL (custom/llama.cpp), API key entry, or — with a saved
   *  key on file — straight to the model chooser (direct change). */
  const beginProviderConnect = (providerId: string): void => {
    const entry = getCatalogEntry(providerId)
    if (!entry) {
      addLoginRow(`Unknown provider "${providerId}".`, { persist: false })
      return
    }
    setShowProviderPicker(/*showProviderPicker*/ false)
    if (entry.needsBaseUrl) {
      hideLoginRows()
      setLoginFlow({ stage: "baseUrl", providerId: entry.id, baseUrl: "", apiKey: "", models: null })
      addLoginRow(
        `${g("prompt")} ${entry.label}: enter Base URL (default ${entry.defaultBaseUrl}) — Enter or 'default' takes the default, Esc cancels.`,
        { persist: false, ttlMs: 0 },
      )
    } else if (entry.needsApiKey) {
      const stored = readStoredKey(entry.id)
      if (stored.apiKey) {
        // Saved key: direct change — fetch + model chooser, no re-typing.
        void fetchAndPickModel(entry.id, stored.baseUrl || entry.defaultBaseUrl, stored.apiKey)
      } else {
        hideLoginRows()
        setLoginFlow({ stage: "apiKey", providerId: entry.id, baseUrl: entry.defaultBaseUrl, apiKey: "", models: null })
        addLoginRow(`${g("prompt")} ${entry.label}: enter API key, or type 'skip'. Esc cancels.`, {
          persist: false,
          ttlMs: 0,
        })
      }
    } else {
      hideLoginRows()
      setLoginFlow({ stage: "apiKey", providerId: entry.id, baseUrl: entry.defaultBaseUrl, apiKey: "", models: null })
      addLoginRow(`${g("prompt")} ${entry.label}: enter API key (optional — type 'skip' to skip).`, {
        persist: false,
        ttlMs: 0,
      })
    }
  }

  const cancelLogin = (): void => {
    if (!loginFlow) {
      addSystemMessage("Nothing to cancel — use /provider to connect.")
      return
    }
    hideLoginRows() // cancelled → every wizard prompt row vanishes now
    setLoginFlow(null)
    setShowProviderPicker(/*showProviderPicker*/ false)
    // The outcome line is the one thing kept visible — briefly — then its own
    // TTL fades it too, so a cancelled connect leaves the transcript clean.
    addSystemMessage("Provider connect cancelled.", { persist: false, ttlMs: 10_000 })
  }

  /** Advance the /login wizard one composer submit. Never throws: every
   *  branch either re-prompts or completes the switch. */
  const advanceLogin = async (raw: string): Promise<void> => {
    const flow = loginFlowRef.current
    if (!flow) return
    if (flow.stage === "provider") {
      const n = parseInt(raw, 10)
      let entry =
        Number.isFinite(n) && n >= 1 && n <= PROVIDER_CATALOG.length
          ? PROVIDER_CATALOG[n - 1]
          : getCatalogEntry(raw.toLowerCase())
      // "nim" shorthand → NVIDIA NIM.
      if (!entry && raw.toLowerCase() === "nim") entry = getCatalogEntry("nvidia-nim")
      if (!entry) {
        addLoginRow(
          `Unknown provider "${raw}". Type 1-${PROVIDER_CATALOG.length} or an id (${PROVIDER_CATALOG.map((e) => e.id).join(", ")}).`,
          { persist: false },
        )
        return
      }
      beginProviderConnect(entry.id)
      return
    }
    if (flow.stage === "baseUrl") {
      const entry = getCatalogEntry(flow.providerId)
      const defBase = entry?.defaultBaseUrl ?? "http://localhost:8080"
      // Empty Enter AND the word "default" both take the default (composer
      // subtleties must never trap the user on this step).
      const base = raw.length === 0 || raw.toLowerCase() === "default" ? defBase : raw
      try {
        void new URL(base)
      } catch {
        addLoginRow(`"${raw}" is not a valid URL. Try again (e.g. ${entry?.defaultBaseUrl}).`, { persist: false })
        return
      }
      if (entry && !entry.needsApiKey && !entry.keyOptional) {
        // llama.cpp without a key: fetch models, then choose in the picker.
        addLoginRow(`Fetching models from ${base}…`, { persist: false })
        const res = await fetchModelsDetailed(flow.providerId, base, "")
        const pre = resolveModels(flow.providerId, res)
        if (pre.models.length === 0) {
          applyProviderSwitch(flow.providerId, entry?.defaultModel ?? "", base, "")
          hideLoginRows() // completed → prompts gone; the ✓ notice below fades on its TTL
          setLoginFlow(null)
          addSystemMessage(
            `${g("ok")} ${entry.label} connected at ${base} (no model list — set one via /provider use ${flow.providerId} <model>).`,
            { ttlMs: 10_000 },
          )
          return
        }
        setProviderInfo({ label: providerLabelFor(flow.providerId), host: providerHostFor(base) })
        setAvailableModels(pre.models)
        hideLoginRows()
        setLoginFlow({ stage: "model", providerId: flow.providerId, baseUrl: base, apiKey: "", models: pre.models })
        setShowModelPicker(/*showModelPicker*/ true)
        addLoginRow(
          `Choose a model in the picker ↑↓ Enter (${res.models.length} live from ${base}). Esc closes it — then type the exact id.`,
          { persist: false, ttlMs: 0 },
        )
        return
      }
      hideLoginRows()
      setLoginFlow({ stage: "apiKey", providerId: flow.providerId, baseUrl: base, apiKey: "", models: null })
      addLoginRow(`${g("prompt")} Base URL set to ${base}. Now enter API key, or type 'skip'.`, {
        persist: false,
        ttlMs: 0,
      })
      return
    }
    if (flow.stage === "apiKey") {
      const entry = getCatalogEntry(flow.providerId)
      // "skip" (also "-" / "none") explicitly skips the key — empty Enter
      // works too, but a typed word is unambiguous. Empty input otherwise
      // reuses the backend's stored key when one exists.
      const lowered = raw.toLowerCase()
      const key =
        lowered === "skip" || lowered === "-" || lowered === "none"
          ? ""
          : cleanApiKey(raw) || readStoredKey(flow.providerId).apiKey
      if (!key && entry?.needsApiKey) {
        // A skipped/missing key on a gated backend can only 401 into the
        // tiny static list — refuse and re-prompt instead of opening it.
        addLoginRow(`${g("prompt")} ${entry.label} needs an API key — paste it, or Esc to cancel.`, {
          persist: false,
          ttlMs: 0,
        })
        return
      }
      await fetchAndPickModel(flow.providerId, flow.baseUrl, key)
      return
    }
    if (flow.stage === "model") {
      const models = flow.models ?? []
      const n = parseInt(raw, 10)
      let picked: string | undefined
      if (Number.isFinite(n) && n >= 1 && n <= models.length) picked = models[n - 1]
      else if (models.includes(raw)) picked = raw
      else if (raw.length > 0 && models.some((m) => m.toLowerCase() === raw.toLowerCase())) {
        picked = models.find((m) => m.toLowerCase() === raw.toLowerCase())
      } else if (raw.length > 0 && models.length === 0) {
        // No listable models (custom endpoint without /v1/models): accept an
        // explicitly typed id, VS Code custom-provider style.
        picked = raw
      }
      if (!picked) {
        addLoginRow(`Pick 1-${models.length} or an exact id from the list above.`, { persist: false })
        return
      }
      applyProviderSwitch(flow.providerId, picked, flow.baseUrl, flow.apiKey)
      hideLoginRows() // completed → prompts gone; the ✓ notice below fades on its TTL
      setLoginFlow(null)
      const entry = getCatalogEntry(flow.providerId)
      addSystemMessage(`${g("ok")} Connected: ${entry?.label ?? flow.providerId} · ${picked}`, { ttlMs: 10_000 })
      return
    }
  }

  /** Persist + hot-swap the active model (SKT AI LABS's local.model.set with
   *  `recent: true`). The agent bakes `model` into its provider at
   *  construction, so agentConfigRef is updated and agentRef nulled — the
   *  next run rebuilds against the new model. */
  const selectModel = (id: string): void => {
    setShowModelPicker(/*showModelPicker*/ false)
    if (id === activeModel) return
    const nextRecents = pushRecent(modelRecents, id)
    saveConfig({ model: id, modelRecents: nextRecents })
    setActiveModel(id)
    setModelRecents(nextRecents)
    agentConfigRef.current = {
      ...(agentConfigRef.current ?? createAgentConfig(config ?? {})),
      model: id,
    }
    agentRef.current = null
    addSystemMessage(`Model switched to ${id}.`)
  }

  const toggleModelFavorite = (id: string): void => {
    const next = toggleFavorite(modelFavorites, id)
    setModelFavorites(next)
    saveConfig({ modelFavorites: next })
  }

  /** ModelPicker choice while /login is mid-flow: completes the switch with
   *  the flow's provider/baseUrl/apiKey instead of only swapping the model. */
  const selectModelDuringLogin = (id: string): void => {
    const flow = loginFlowRef.current
    setShowModelPicker(/*showModelPicker*/ false)
    if (!flow || flow.stage !== "model") return
    hideLoginRows() // completed → prompts gone; the ✓ notice below fades on its TTL
    setLoginFlow(null)
    const models = flow.models ?? []
    applyProviderSwitch(flow.providerId, id, flow.baseUrl, flow.apiKey, models)
    addSystemMessage(`${g("ok")} Connected: ${providerLabelFor(flow.providerId)} · ${id}`, { ttlMs: 10_000 })
  }

  const leaderActions: WhichKeyAction[] = [
    {
      key: "s",
      label: "subagents panel",
      run: () => {
        setPanelInitialTab("all")
        setShowSubagentPanel(/*showSubagentPanel*/ true)
        setTaskHint(null)
      },
    },
    {
      key: "b",
      label: "background tasks panel",
      run: () => {
        setPanelInitialTab("background")
        setShowSubagentPanel(/*showSubagentPanel*/ true)
        setTaskHint(null)
      },
    },
    { key: "a", label: "agent picker", run: () => setShowAgentPicker(/*showAgentPicker*/ true) },
    { key: "t", label: "theme picker", run: () => setShowThemePicker(/*showThemePicker*/ true) },
    { key: "m", label: "model picker", run: openModelPicker },
    { key: "i", label: "sidebar", run: () => setShowSidebar((open) => !open) },
    { key: "q", label: "session picker", run: () => setShowPicker(/*showPicker*/ true) },
    {
      key: "n",
      label: "new chat",
      run: () => {
        setShowPicker(/*showPicker*/ false)
        sessionIdRef.current = null
        currentSessionRef.current = null
        setMessages([])
        setStaticEpoch((e) => e + 1)
        addSystemMessage("New conversation started.", { persist: false })
      },
    },
    { key: "p", label: "cycle permission mode", run: togglePermissionMode },
    { key: "u", label: "undo checkpoint", run: undoCheckpoint },
    { key: "y", label: "redo checkpoint", run: redoCheckpoint },
    {
      key: "d",
      label: "abort current turn",
      run: () => {
        abortControllerRef.current?.abort()
        sweepOrphanedDialogs()
      },
    },
    {
      key: "x",
      label: "clear queued prompts",
      run: () => {
        const n = queueRef.current.length
        if (n > 0) {
          queueRef.current = []
          setQueuedPrompts([])
          addSystemMessage(`Cleared ${n} queued prompt${n === 1 ? "" : "s"}.`)
        }
      },
    },
    {
      key: "h",
      label: "help",
      run: () => addSystemMessage(SLASH_COMMANDS.map((cmd) => `/${cmd.name} — ${cmd.description}`).join("\n")),
    },
  ]

  /** Command-palette rows: every leader chord (as an action) plus the live
   *  slash-command registry — SKT AI LABS's palette over trayambak's own commands. */
  const paletteEntries: PaletteEntry[] = [
    ...leaderActions.map((a): PaletteEntry => ({
      id: `leader.${a.key}`,
      title: a.label.charAt(0).toUpperCase() + a.label.slice(1),
      category: "Actions",
      keybinding: `ctrl+k ${a.key}`,
      suggested: ["t", "q", "s", "p", "m", "i"].includes(a.key),
      run: a.run,
    })),
    {
      id: "leader.lead",
      title: "Keyboard shortcut help",
      category: "Actions",
      keybinding: "ctrl+k",
      run: () => setShowWhichKey(/*showWhichKey*/ true),
    },
    ...slashCommandService.registry.all().map((cmd, i): PaletteEntry => ({
      id: `cmd.${cmd.name}.${i}`,
      title: `/${cmd.name}`,
      description: cmd.description,
      category: cmd.category || "Commands",
      suggested: cmd.name === "theme" || cmd.name === "models",
      run: () => runSlash(cmd.name, ""),
    })),
  ]

  // Any open picker/panel owns the screen: the permission layer stands down
  // for the six basic overlays; the persistent chrome (background runner,
  // footer, composer) stands down for every overlay including the panels.
  const pickerOverlayOpen =
    showThemePicker ||
    showPalette ||
    showModelPicker ||
    showProviderPicker ||
    showSplash ||
    showSandboxSetup ||
    showBootCine
  const chromeHidden = pickerOverlayOpen || showWhichKey || showSubagentPanel || showAgentPicker

  return (
    <Box
      flexDirection="column"
      height={rows}
      // "Blue outline, halka rounded corners": round → ╭╮╰╯ caps, and the
      // brand-blue primary paints the conversation box's outline (the
      // theme's grey border only backs the inner tool boxes now). While a
      // turn runs the outline EDGE-CHASES (rootPulse above): exactly one
      // side lights with the palette colour, the rest hold brand-blue.
      borderStyle="round"
      borderColor={rootPulse.color}
      borderTopColor={rootPulse.top}
      borderRightColor={rootPulse.right}
      borderBottomColor={rootPulse.bottom}
      borderLeftColor={rootPulse.left}
      // Scrollback prefix present → drop the TOP border: the evicted
      // segment's │ walls flow straight into the frame's (one continuous
      // conversation box — the divider line between prefix and live tail
      // must hide). Fresh sessions (no prefix) keep the ╭ cap.
      borderTop={hasStaticPrefix ? false : undefined}
    >
      {showBootCine ? (
        <BootCine onDone={() => setBootCineDone(/*bootCineDone*/ true)} />
      ) : showSplash ? (
        <SplashScreen onDone={() => setSplashDone(/*splashDone*/ true)} />
      ) : showPalette ? (
        <CommandPalette
          entries={paletteEntries}
          onSelect={(entry) => {
            setShowPalette(/*showPalette*/ false)
            entry.run()
          }}
          onClose={() => setShowPalette(/*showPalette*/ false)}
        />
      ) : showThemePicker ? (
        <ThemePicker
          themes={getTrayambakThemes().map(themeToPickerOption)}
          defaultTheme={getLiveTheme().name}
          onSelect={(name) => {
            applyTrayambakTheme(name)
            saveConfig({ themeName: name })
            setShowThemePicker(/*showThemePicker*/ false)
          }}
          onExit={() => {
            applyTrayambakTheme(config?.themeName ?? "trayambak-dark")
            setShowThemePicker(/*showThemePicker*/ false)
          }}
        />
      ) : showSandboxSetup ? (
        <SandboxSetup
          cwd={config?.cwd ?? bootConfig.cwd}
          onSelect={(mode) => {
            setPermissionMode(mode)
            syncUiMode(mode)
            setSandboxDone(/*sandboxDone*/ true)
            addSystemMessage(`Sandbox ready (${mode}) — change anytime with /mode.`)
          }}
        />
      ) : showWhichKey ? (
        <WhichKey actions={leaderActions} onClose={() => setShowWhichKey(/*showWhichKey*/ false)} />
      ) : showSubagentPanel ? (
        <SubagentPanel
          cards={messages.filter((m) => !!m.subagentId)}
          background={Array.from(backgroundSubagents.values())}
          initialTab={panelInitialTab}
          onClose={() => setShowSubagentPanel(/*showSubagentPanel*/ false)}
          onCancel={cancelBackgroundJob}
        />
      ) : showAgentPicker ? (
        <AgentPicker
          profiles={listAgentProfiles()}
          onSelect={(value) => {
            setShowAgentPicker(/*showAgentPicker*/ false)
            pendingAgentTypeRef.current = value
            addSystemMessage(
              `Agent selected: ${value}\nType the task prompt and press Enter (prefix --bg to run it in the background, or /agent to re-select).`,
              { persist: false },
            )
          }}
          onExit={() => setShowAgentPicker(/*showAgentPicker*/ false)}
        />
      ) : showProviderPicker ? (
        <ProviderPicker
          providers={PROVIDER_CATALOG.map((e) => {
            const active = (loadConfig().provider ?? "nvidia").toLowerCase() === e.id
            const hasKey = readStoredKey(e.id).apiKey !== "" || (active && loadConfig().apiKey !== "")
            return {
              id: e.id,
              label: e.label,
              endpoint: e.defaultBaseUrl,
              hasKey,
              needsBaseUrl: e.needsBaseUrl,
              active,
            }
          })}
          currentId={loadConfig().provider ?? "nvidia"}
          onSelect={(id) => beginProviderConnect(id)}
          onExit={() => {
            // Mid-connect Esc exits the whole connect (no stranded flow).
            if (loginFlowRef.current) cancelLogin()
            else setShowProviderPicker(/*showProviderPicker*/ false)
          }}
        />
      ) : showModelPicker ? (
        <ModelPicker
          models={availableModels ?? []}
          loading={availableModels === null}
          favorites={modelFavorites}
          recents={modelRecents}
          current={activeModel}
          providerName={providerInfo.label}
          endpoint={providerInfo.host}
          onSelect={loginFlow ? selectModelDuringLogin : selectModel}
          onToggleFavorite={toggleModelFavorite}
          onClose={() => {
            // Mid-connect Esc exits the whole connect (no stranded flow).
            if (loginFlowRef.current) cancelLogin()
            else setShowModelPicker(/*showModelPicker*/ false)
          }}
        />
      ) : showPicker ? (
        <SessionPicker
          sessions={loadSessions()}
          {...createSessionPickerActions({
            setShowPicker,
            sessionIdRef,
            currentSessionRef,
            setMessages,
            setStaticEpoch,
            addSystemMessage,
          })}
        />
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" flexGrow={1}>
            {/* Welcome lives until the first real exchange — not until the
              first row. Boot notices (GitHub reconnect, update check,
              sandbox ready) are system rows: the old messages.length === 0
              check let any one of them kill the WelcomeScreen forever
              (observed live: logging in hid the logo on every boot). */}
            {!messages.some((m) => m.role !== "system") ? <WelcomeScreen /> : null}
            {messages.length === 0 ? null : (
              <Box flexDirection="column" flexGrow={1}>
                {/* No TRAYAMBAK header row inside the frame: the compact logo
                  (+ its padding row) claimed 2 of the frame's rows on every
                  render and only ever sat there beside stray header text —
                  wasted vertical space at the top of the transcript box.
                  Branding still shows on the WelcomeScreen (empty state). */}
                <MessageList
                  messages={messages}
                  isLoading={isLoading}
                  isStreaming={isStreaming}
                  scrollBack={scrollBack}
                  phase={status}
                  // PermissionOverlay stole ~12 rows from the message frame
                  // unbudgeted, clipping the reading window at approval
                  // time (snap-back look). Budget it like pendingQuestion.
                  extraBottomRows={(pendingQuestion ? 9 : 0) + (pendingPermissions.length > 0 ? 12 : 0)}
                  staticEpoch={staticEpoch}
                  onHasPrefix={setHasStaticPrefix}
                  expandOutput={expandOutput}
                />
              </Box>
            )}
          </Box>
          {shouldShowSidebar(showSidebar, stdout.columns) ? (
            <Sidebar
              title={currentSessionRef.current?.sessionName ?? "New chat"}
              workspace={config?.cwd ?? bootConfig.cwd}
              tokenCount={tokenCount}
              contextWindow={bootConfig.contextWindow ?? config?.contextWindow}
              model={activeModel}
              mcpServers={config?.mcpServers ?? bootConfig.mcpServers}
              todos={sidebarTodos}
            />
          ) : null}
        </Box>
      )}
      {!pickerOverlayOpen && pendingPermissions.length > 0 && (
        <PermissionOverlay
          permissionMode={permissionMode}
          pendingRequests={pendingPermissions}
          composerHasText={composerHasText}
          onApprove={(id) => resolvePermission(id, /*approved*/ true)}
          onDeny={(id) => resolvePermission(id, /*approved*/ false)}
          onApproveSession={(id) => {
            const row = pendingPermissions.find((p) => p.id === id)
            if (row) {
              addSessionPermissionRule({ tool: row.tool, pattern: permissionSubject(row.args), action: "allow" })
              addSystemMessage(`Session rule: allow ${row.tool} → ${permissionSubject(row.args)}`)
            }
            resolvePermission(id, /*approved*/ true)
          }}
          onApproveAlways={(id) => persistAndResolve(id, "allow")}
          onDenyAlways={(id) => persistAndResolve(id, "deny")}
        />
      )}
      {bgRunning && !chromeHidden && (
        <Box flexDirection="row" alignItems="center" marginTop={1} marginBottom={1} marginLeft={2}>
          <Spinner color={theme.warning}>Background subagents working…</Spinner>
          <Text color={theme.textMuted}>
            {" "}
            ({Array.from(backgroundSubagents.values()).filter((j) => j.status === "running").length} active)
          </Text>
        </Box>
      )}
      {!chromeHidden && (
        <Footer
          info={statusBarInfo}
          backgroundSubagents={backgroundSubagents}
          subagentTabs={Array.from(backgroundSubagents.values())}
        />
      )}
      {!chromeHidden && (
        <PromptInput
          onSubmit={handleInput}
          onSlashCommand={runSlash}
          onChoose={handleChoose}
          onHistoryScroll={handleHistoryScroll}
          onEnhance={enhanceDraft}
          isLoading={isLoading}
          disabled={showPicker}
          permissionPending={pendingPermissions.length > 0}
          onComposerHasTextChange={setComposerHasText}
          questionHint={pendingQuestion}
          // Picker owns Enter while open: without the !showPicker gate,
          // askMode re-enabled the composer (inputActive = !disabled ||
          // askMode) and one Enter BOTH answered the question AND selected
          // the session row. Composer stands down until the picker closes.
          askMode={(pendingQuestion !== null || waitingCustom) && !showPicker}
          waitingCustom={waitingCustom}
          cwd={config?.cwd ?? bootConfig.cwd}
          draftRequest={draftRequest}
          onRetryEdit={() => {
            const last = lastUserPromptRef.current
            if (!last) {
              addSystemMessage("No previous prompt to edit.")
              return
            }
            setDraftRequest((prev) => ({ text: last, nonce: (prev?.nonce ?? 0) + 1 }))
          }}
          onInject={handleInject}
          onCtrlCEmpty={handleCtrlCEmpty}
          commandList={[
            ...slashCommandService.registry.all().map((cmd) => ({
              name: cmd.name,
              description: cmd.description,
              category: cmd.category,
              aliases: cmd.aliases,
              argsHint: cmd.argsHint,
            })),
            ...promptCommands.map((c) => ({
              name: c.name,
              description: c.description,
              category: "Custom",
              argsHint: c.argumentHint,
            })),
          ]}
        />
      )}
    </Box>
  )
}

export const renderTrayambakApp = (props: TrayambakAppProps): void => {
  render(<TrayambakApp {...props} />)
}

export default TrayambakApp

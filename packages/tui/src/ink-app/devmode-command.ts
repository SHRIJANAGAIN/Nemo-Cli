/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * `/devmode` — developer-mode and pentest-toolset control.
 *
 * Extracted from `App.tsx` (which exceeded the 4000-line `max-file-size`
 * cap). The handler is deliberately a factory rather than a bare function:
 * it needs to WRITE three refs (`agentConfigRef`, `agentRef`,
 * `questionResolverRef`) and post system rows, so it cannot be pure. Passing
 * that mutable surface in explicitly keeps the coupling visible and lets the
 * tests drive the whole flow with plain stubs.
 *
 * The behavioural contract this module owns:
 *
 *  - Every write persists to config AND patches `agentConfigRef`, then
 *    nulls `agentRef` so the next message rebuilds the agent with the new
 *    toolsets/engine flags. No restart is ever required.
 *  - Enabling pentest needs a LIVE-VALID license checked server-side. The
 *    refusal message reports the reason and leaves existing state untouched —
 *    a failed attempt never flips anything, so the message reports what IS.
 *  - A failure never mutates state; it reports state-accurately.
 *  - Bare `/devmode` opens an ON/OFF chooser; choosing ON chains straight
 *    into the license-key prompt so there is no step to forget.
 */

import { createAgentConfig } from "./app-bootstrap.js"
import type { TrayambakConfig } from "../../../../apps/runtime/src/config.js"
import {
  normalizeLicenseKey,
  serverActivateLicenseKey,
  serverCanUsePentest,
  serverMintTrial,
  serverVerifyLicenseKey,
} from "../../../../apps/runtime/src/license.js"
import { loadConfig, saveConfig } from "../../../../apps/runtime/src/config.js"
import type { QuestionRequest } from "./types.js"
import { g } from "./glyphs.js"

/** Snapshot of the three developer-mode switches, read from persisted config. */
export interface DevmodeSnapshot {
  enabled: boolean
  gate: boolean
  pentest: boolean
}

export interface DevmodeDeps {
  /** Post a system row into the transcript. */
  addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
  /** Set (or clear) the pending question dialog. */
  setPendingQuestion: (request: QuestionRequest | null) => void
  /** Resolver the composer calls when the user answers the pending question. */
  questionResolverRef: { current: ((answers: string[]) => void) | null }
  /** Live agent config, patched in place so the next turn sees the change. */
  agentConfigRef: { current: TrayambakConfig | null }
  /** Nulled to force an agent rebuild on the next message. */
  agentRef: { current: unknown }
  /** Config as loaded at boot; used only as the `createAgentConfig` seed. */
  config: Partial<TrayambakConfig> | null
}

const DEFAULT_TOOLSETS = ["core", "agentic", "ops", "tasks", "mcp", "skills"]

/** `crypto.randomUUID` is the id source; the fallback keeps older runtimes working. */
function newQuestionId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Read the three switches from persisted config (never from a stale ref). */
export function devSnapshot(): DevmodeSnapshot {
  const c = loadConfig()
  return {
    enabled: c.developerMode?.enabled === true,
    gate: c.developerMode?.gateEnabled === true,
    pentest: !(c.toolsets?.disabled ?? []).includes("pentest"),
  }
}

/**
 * Run `/devmode <args>`. Returns nothing — every observable effect is either
 * a config write or a system row, so callers stay side-effect free.
 */
export function runDevmode(rawArgs: string, deps: DevmodeDeps): void {
  const { addSystemMessage, setPendingQuestion, questionResolverRef, agentConfigRef, agentRef, config } = deps

  /** Persist a config patch AND arm the agent rebuild that makes it live. */
  const syncAgentConfig = (patch: Partial<TrayambakConfig>): void => {
    agentConfigRef.current = { ...(agentConfigRef.current ?? createAgentConfig(config ?? {})), ...patch }
    agentRef.current = null // rebuild on the next run (same pattern as a model switch)
  }

  const setDevEnabled = (enabled: boolean): void => {
    const developerMode = { ...loadConfig().developerMode, enabled }
    saveConfig({ developerMode })
    syncAgentConfig({ developerMode })
  }

  const applyPentest = async (wantOn: boolean): Promise<void> => {
    // License gate (server-side): enabling pentest needs a LIVE-valid license
    // on this machine. Disabling always works. The tool assembly
    // (createDefaultTools) enforces the same gate per execution, so this menu
    // can never promise what the loop withholds.
    if (wantOn) {
      const cfg = loadConfig()
      const v = await serverCanUsePentest(cfg.licenseKey, { serverUrl: cfg.licenseServerUrl })
      if (v.valid !== true) {
        addSystemMessage(
          `Pentest tools stay DISABLED — ${v.reason ?? "no valid license"}. Bind a key: /devmode on 1102-XXXX-XXXX-XXXX.`,
        )
        return
      }
    }
    const c = loadConfig()
    const defaults = c.toolsets?.defaults?.length ? c.toolsets.defaults : DEFAULT_TOOLSETS
    const cur = c.toolsets?.disabled ?? []
    const disabled = wantOn ? cur.filter((t) => t !== "pentest") : cur.includes("pentest") ? cur : [...cur, "pentest"]
    const toolsets = {
      defaults,
      disabled,
      ...(c.toolsets?.platform ? { platform: c.toolsets.platform } : {}),
    }
    saveConfig({ toolsets })
    syncAgentConfig({ toolsets })
    addSystemMessage(
      wantOn
        ? `${g("ok")} Pentest tools ENABLED — the model gets trayambak__Pentest* + the 83-tool catalog from its next message (defensive guard for infrastructure, never exploitation).`
        : `${g("ok")} Pentest tools DISABLED — the pentest toolset no longer reaches the model.`,
      { ttlMs: 10_000 },
    )
  }

  const openPentestMenu = (): void => {
    const s = devSnapshot()
    const request: QuestionRequest = {
      id: newQuestionId("devmode"),
      header: "Devmode · Pentest",
      question:
        `Pentest tools: ${s.pentest ? "ENABLED" : "DISABLED"} · Gate: ${s.gate ? "ON" : "OFF"} (/gate on|off). ` +
        "Defensive guard for infrastructure only — never exploitation. Enable or disable the pentest suite?",
      options: [
        { label: "Enable pentest tools", description: "Model sees trayambak__Pentest* (83-tool security catalog)" },
        { label: "Disable pentest tools", description: "Hide the pentest toolset from the model" },
        { label: "Cancel", description: "Keep the current setting" },
      ],
      multiSelect: false,
    }
    questionResolverRef.current = (answers: string[]): void => {
      const choice = (answers[0] ?? "").trim().toLowerCase()
      if (choice === "1" || choice.startsWith("enable")) {
        void applyPentest(/*wantOn*/ true)
      } else if (choice === "2" || choice.startsWith("disable")) {
        void applyPentest(/*wantOn*/ false)
      } else {
        addSystemMessage(
          `Pentest menu closed — pentest tools remain ${devSnapshot().pentest ? "ENABLED" : "DISABLED"}.`,
          { ttlMs: 10_000 },
        )
      }
    }
    setPendingQuestion(request)
  }

  // License-key unlock: `/devmode on 1102-XXXX-XXXX-XXXX` ACTIVATES the code
  // on this machine (server binds key→machine, 1-machine limit) and enables
  // devmode with it in one step (key persists to config, agent rebuilds).
  // Always-online: the server answers live, a forged or elsewhere-bound key
  // refuses with its reason. No valid activation anywhere = stays OFF.
  const unlockWithKey = async (rawKey: string): Promise<boolean> => {
    const cfg = loadConfig()
    const a = await serverActivateLicenseKey(rawKey, { serverUrl: cfg.licenseServerUrl })
    if (a.ok !== true) {
      // State-accurate refusal: a failed attempt never flips existing state,
      // so report what IS, not what the attempt wanted.
      const stillOn = loadConfig().developerMode?.enabled === true
      addSystemMessage(
        `Activation failed (${a.reason ?? "unknown"}) — developer mode remains ${stillOn ? "ON (unchanged)" : "OFF"}. Usage: /devmode on 1102-XXXX-XXXX-XXXX`,
      )
      return false
    }
    const developerMode = { ...loadConfig().developerMode, enabled: true }
    // Persist the CANONICAL key, not the raw paste. `normalizeLicenseKey`
    // uppercases and strips the 1102-XXXX-XXXX-XXXX punctuation into the
    // 16-char Crockford form the verifier expects, so what lands in config is
    // exactly what `verifyLicenseKey` compares against later.
    const key = normalizeLicenseKey(rawKey) ?? rawKey.trim()
    saveConfig({ developerMode, licenseKey: key })
    syncAgentConfig({ developerMode, licenseKey: key })
    return true
  }

  const configuredUnlock = async (): Promise<boolean> => {
    const cfg = loadConfig()
    const v = await serverVerifyLicenseKey(cfg.licenseKey, { serverUrl: cfg.licenseServerUrl })
    if (v.valid !== true) {
      const stillOn = loadConfig().developerMode?.enabled === true
      addSystemMessage(
        `Developer mode remains ${stillOn ? "ON (unchanged)" : "OFF"} — ${v.reason ?? "no license configured"}. Usage: /devmode on 1102-XXXX-XXXX-XXXX`,
      )
      return false
    }
    return true
  }

  const devmodeOnSuccess = (): void => {
    addSystemMessage(`Developer mode: ON — pentest menu open below (1 enable · 2 disable · Esc cancels).`)
    openPentestMenu()
  }

  // Subcommand dispatch is case-insensitive, but the ARGUMENT is not: a pasted
  // license key keeps its original case so `normalizeLicenseKey` sees the real
  // characters. Lowercasing the whole string would silently mangle a key.
  const rawArg = rawArgs.trim()
  const darg = rawArg.toLowerCase()
  const s = devSnapshot()
  const onParts = rawArg.split(/\s+/)

  if (onParts[0]?.toLowerCase() === "on" && onParts.length > 1) {
    addSystemMessage("Activating license on this machine…")
    void unlockWithKey(onParts.slice(1).join(" ")).then((ok) => {
      if (ok) devmodeOnSuccess()
    })
    return
  }

  if (darg === "") {
    // Bare /devmode: ON/OFF chooser. Choosing ON chains straight into a
    // license prompt (no separate step to remember).
    const cur = devSnapshot()
    questionResolverRef.current = (answers: string[]): void => {
      const choice = (answers[0] ?? "").trim().toLowerCase()
      if (choice === "1" || choice.startsWith("turn on") || choice.startsWith("on")) {
        const keyRequest: QuestionRequest = {
          id: newQuestionId("devmode-key"),
          header: "Devmode · License",
          question: "Paste license key (1102-XXXX-XXXX-XXXX). Esc cancels.",
          options: [{ label: "Cancel", description: "Keep developer mode OFF" }],
          multiSelect: false,
        }
        questionResolverRef.current = (keyAnswers: string[]): void => {
          const raw = (keyAnswers[0] ?? "").trim()
          // "Cancel" (label or number) aborts; anything else is a key attempt
          // — a real key is 16+ chars so it can never equal it.
          if (!raw || raw.toLowerCase() === "cancel") {
            addSystemMessage("Developer mode stays OFF.")
            return
          }
          addSystemMessage("Activating license on this machine…")
          void unlockWithKey(raw).then((ok) => {
            if (ok) devmodeOnSuccess()
          })
        }
        setPendingQuestion(keyRequest)
      } else if (choice === "2" || choice.startsWith("turn off") || choice.startsWith("off")) {
        if (cur.enabled) setDevEnabled(/*enabled*/ false)
        addSystemMessage("Developer mode: OFF.")
      } else {
        addSystemMessage(`Developer mode stays ${cur.enabled ? "ON" : "OFF"}.`)
      }
    }
    setPendingQuestion({
      id: newQuestionId("devmode"),
      header: "Devmode",
      question: `Developer mode is currently ${cur.enabled ? "ON" : "OFF"}. Turn it ON (license key follows) or OFF?`,
      options: [
        { label: "Turn ON", description: "Asks for the license key next" },
        { label: "Turn OFF", description: "Disable developer mode" },
        { label: "Cancel", description: "Keep the current setting" },
      ],
      multiSelect: false,
    })
    return
  }

  if (darg === "on") {
    addSystemMessage("Checking license with the server…")
    void configuredUnlock().then((ok) => {
      if (!ok) return
      if (!s.enabled) setDevEnabled(/*enabled*/ true)
      devmodeOnSuccess()
    })
    return
  }

  if (darg === "off" || (darg === "" && s.enabled)) {
    if (s.enabled) setDevEnabled(/*enabled*/ false)
    addSystemMessage(
      `Developer mode: OFF — pentest tools stay ${s.pentest ? "ENABLED" : "DISABLED"} (manage via /devmode on).`,
    )
    return
  }

  if (darg === "trial") {
    // Self-service trial: the server mints a short pentest key BORN BOUND to
    // this machine (1 live trial per machine). No paste, no reseller — key
    // saves straight into config like a typed one.
    const cfgTrial = loadConfig()
    addSystemMessage("Requesting a trial license for this machine…")
    void serverMintTrial({ serverUrl: cfgTrial.licenseServerUrl }).then((t) => {
      if (t.ok !== true || !t.key) {
        addSystemMessage(`Trial unavailable — ${t.reason ?? "unknown error"}.`)
        return
      }
      const developerMode = { ...loadConfig().developerMode, enabled: true }
      // Persist the CANONICAL key, not the raw wire copy — same rule as the
      // typed-key path above. The server mints uppercase, but anything
      // non-canonical (lowercase, spaced) must never land verbatim in
      // config: Crockford base32 is uppercase-canonical.
      const trialKey = normalizeLicenseKey(t.key) ?? t.key.trim()
      saveConfig({ developerMode, licenseKey: trialKey })
      syncAgentConfig({ developerMode, licenseKey: trialKey })
      addSystemMessage(
        `Trial license active (${t.days ?? "?"} days, this machine only, key ${trialKey}) — pentest menu open below (1 enable · 2 disable · Esc cancels).`,
      )
      openPentestMenu()
    })
    return
  }

  if (darg === "status") {
    const st = devSnapshot()
    const cfgStatus = loadConfig()
    addSystemMessage("Checking license with the server…", { persist: false })
    void serverVerifyLicenseKey(cfgStatus.licenseKey, { serverUrl: cfgStatus.licenseServerUrl }).then((lic) => {
      const licText =
        lic.valid === true
          ? `live-valid (${lic.plan}, exp ${lic.exp ? new Date(lic.exp * 1000).toISOString().slice(0, 10) : "?"})`
          : `invalid (${lic.reason ?? "no license"})`
      addSystemMessage(
        `Developer mode: ${st.enabled ? "ON" : "OFF"} · Pentest tools: ${st.pentest ? "ENABLED" : "DISABLED"} · Gate: ${st.gate ? "ON" : "OFF"} (/gate on|off) · License: ${licText}`,
        { persist: false },
      )
    })
    return
  }

  if (darg === "pentest") {
    if (s.enabled) openPentestMenu()
    else addSystemMessage("Developer mode is OFF — /devmode on to open the pentest tools menu.")
    return
  }

  addSystemMessage(
    "Usage: /devmode [on 1102-XXXX-XXXX-XXXX|trial|off|status|pentest] — bare /devmode opens the ON/OFF chooser (ON asks for the license key); trial self-serves a short key for this machine.",
  )
}

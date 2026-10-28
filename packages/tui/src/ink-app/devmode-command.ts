/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/devmode` — developer-mode control.
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
 *  - Enabling developer mode needs a LIVE-VALID license checked server-side.
 *    The refusal message reports the reason and leaves existing state untouched —
 *    a failed attempt never flips anything, so the message reports what IS.
 *  - A failure never mutates state; it reports state-accurately.
 *  - Bare `/devmode` opens an ON/OFF chooser; choosing ON chains straight
 *    into the license-key prompt so there is no step to forget.
 */

import { createAgentConfig } from "./app-bootstrap.js"
import type { NemoConfig } from "../../../../apps/runtime/src/config.js"
import {
  normalizeLicenseKey,
  serverActivateLicenseKey,
  serverMintTrial,
  serverVerifyLicenseKey,
} from "../../../../apps/runtime/src/license.js"
import { loadConfig, saveConfig } from "../../../../apps/runtime/src/config.js"
import type { QuestionRequest } from "./types.js"

/** Snapshot of the two developer-mode switches, read from persisted config. */
export interface DevmodeSnapshot {
  enabled: boolean
  gate: boolean
}

export interface DevmodeDeps {
  /** Post a system row into the transcript. */
  addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
  /** Set (or clear) the pending question dialog. */
  setPendingQuestion: (request: QuestionRequest | null) => void
  /** Resolver the composer calls when the user answers the pending question. */
  questionResolverRef: { current: ((answers: string[]) => void) | null }
  /** Live agent config, patched in place so the next turn sees the change. */
  agentConfigRef: { current: NemoConfig | null }
  /** Nulled to force an agent rebuild on the next message. */
  agentRef: { current: unknown }
  /** Config as loaded at boot; used only as the `createAgentConfig` seed. */
  config: Partial<NemoConfig> | null
}

/** `crypto.randomUUID` is the id source; the fallback keeps older runtimes working. */
function newQuestionId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Read the two switches from persisted config (never from a stale ref). */
export function devSnapshot(): DevmodeSnapshot {
  const c = loadConfig()
  return {
    enabled: c.developerMode?.enabled === true,
    gate: c.developerMode?.gateEnabled === true,
  }
}

/**
 * Run `/devmode <args>`. Returns nothing — every observable effect is either
 * a config write or a system row, so callers stay side-effect free.
 */
export function runDevmode(rawArgs: string, deps: DevmodeDeps): void {
  const { addSystemMessage, setPendingQuestion, questionResolverRef, agentConfigRef, agentRef, config } = deps

  /** Persist a config patch AND arm the agent rebuild that makes it live. */
  const syncAgentConfig = (patch: Partial<NemoConfig>): void => {
    agentConfigRef.current = { ...(agentConfigRef.current ?? createAgentConfig(config ?? {})), ...patch }
    agentRef.current = null // rebuild on the next run (same pattern as a model switch)
  }

  const setDevEnabled = (enabled: boolean): void => {
    const developerMode = { ...loadConfig().developerMode, enabled }
    saveConfig({ developerMode })
    syncAgentConfig({ developerMode })
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
    addSystemMessage(`Developer mode: ON — the full tool catalog and developer prompts are live from your next message.`)
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
    addSystemMessage(`Developer mode: OFF.`)
    return
  }

  if (darg === "trial") {
    // Self-service trial: the server mints a short key BORN BOUND to
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
        `Trial license active (${t.days ?? "?"} days, this machine only, key ${trialKey}) — developer mode is ON.`,
      )
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
        `Developer mode: ${st.enabled ? "ON" : "OFF"} · Gate: ${st.gate ? "ON" : "OFF"} (/gate on|off) · License: ${licText}`,
        { persist: false },
      )
    })
    return
  }

  addSystemMessage(
    "Usage: /devmode [on 1102-XXXX-XXXX-XXXX|trial|off|status] — bare /devmode opens the ON/OFF chooser (ON asks for the license key); trial self-serves a short key for this machine.",
  )
}

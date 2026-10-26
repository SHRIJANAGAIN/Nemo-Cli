/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/devmode` contract tests (devmode-command.ts).
 *
 * The handler is security- and licensing-relevant: it is the only path that
 * turns the reviewer-facing toolset on. These tests pin the two properties
 * that matter:
 *
 *  1. **No state change without a live-valid license.** Every refusal path
 *     leaves config exactly as it found it and reports what IS, not what the
 *     attempt wanted.
 *  2. **Every accepted change is live immediately.** A write persists to
 *     config AND patches `agentConfigRef` AND nulls `agentRef` so the next
 *     message rebuilds the agent — otherwise a user who ran `/devmode on`
 *     would see no effect until restart, which is the bug the sync contract
 *     exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../../apps/runtime/src/license.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../apps/runtime/src/license.js")
  return {
    ...actual,
    serverVerifyLicenseKey: vi.fn(async () => ({ valid: false, reason: "no license" })),
    serverActivateLicenseKey: vi.fn(async () => ({ ok: false, reason: "bad key" })),
    serverMintTrial: vi.fn(async () => ({ ok: false, reason: "trial exhausted" })),
  }
})

vi.mock("../../../../apps/runtime/src/config.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../apps/runtime/src/config.js")
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
    saveConfig: vi.fn(),
    createAgentConfig: vi.fn(() => ({ provider: "nvidia" })),
  }
})

import { runDevmode, devSnapshot, type DevmodeDeps } from "./devmode-command.js"
import { loadConfig, saveConfig } from "../../../../apps/runtime/src/config.js"
import {
  serverActivateLicenseKey,
  serverMintTrial,
  serverVerifyLicenseKey,
} from "../../../../apps/runtime/src/license.js"
import type { QuestionRequest } from "./types.js"
import type { NemoConfig } from "../../../../apps/runtime/src/config.js"

const loadMock = loadConfig as unknown as ReturnType<typeof vi.fn>
const saveMock = saveConfig as unknown as ReturnType<typeof vi.fn>
const verifyMock = serverVerifyLicenseKey as unknown as ReturnType<typeof vi.fn>
const activateMock = serverActivateLicenseKey as unknown as ReturnType<typeof vi.fn>
const trialMock = serverMintTrial as unknown as ReturnType<typeof vi.fn>

interface Harness extends DevmodeDeps {
  rows: string[]
  questions: Array<QuestionRequest | null>
  answer: (a: string[]) => void
}

function harness(base: Record<string, unknown> = {}): Harness {
  const rows: string[] = []
  const questions: Array<QuestionRequest | null> = []
  loadMock.mockImplementation(() => base)
  const deps: DevmodeDeps = {
    addSystemMessage: (content) => {
      rows.push(content)
      return content
    },
    setPendingQuestion: (request) => questions.push(request),
    questionResolverRef: { current: null },
    agentConfigRef: { current: { provider: "nvidia" } as unknown as NemoConfig },
    agentRef: { current: { sentinel: true } },
    config: null,
  }
  return {
    ...deps,
    rows,
    questions,
    answer: (a) => deps.questionResolverRef.current?.(a),
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  loadMock.mockImplementation(() => ({}))
  saveMock.mockImplementation(() => undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("devSnapshot", () => {
  it("reads both switches from persisted config", () => {
    loadMock.mockImplementation(() => ({
      developerMode: { enabled: true, gateEnabled: true },
    }))
    expect(devSnapshot()).toEqual({ enabled: true, gate: true })
  })

  it("treats a missing config as everything off", () => {
    expect(devSnapshot()).toEqual({ enabled: false, gate: false })
  })
})

describe("unknown subcommand", () => {
  it("prints usage and changes nothing", () => {
    const h = harness()
    runDevmode("nonsense", h)
    expect(h.rows.join("\n")).toContain("Usage: /devmode")
    expect(saveMock).not.toHaveBeenCalled()
    expect(h.agentRef.current).toEqual({ sentinel: true })
  })
})

describe("activation refusal", () => {
  it("a rejected key never flips developer mode and reports state accurately", async () => {
    activateMock.mockResolvedValue({ ok: false, reason: "bound to another machine" })
    const h = harness({ developerMode: { enabled: true } })
    runDevmode("on 1102-AAAA-BBBB-CCCC", h)
    await flush()

    expect(h.rows.join("\n")).toContain("ON (unchanged)")
    expect(saveMock).not.toHaveBeenCalled()
    expect(h.agentRef.current).toEqual({ sentinel: true })
  })

  it("reports OFF (not OFF-unchanged) when mode was already off", async () => {
    activateMock.mockResolvedValue({ ok: false, reason: "forged" })
    const h = harness({ developerMode: { enabled: false } })
    runDevmode("on 1102-AAAA", h)
    await flush()

    expect(h.rows.join("\n")).toContain("developer mode remains OFF")
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe("activation success", () => {
  it("persists the key, enables mode, patches the agent config, and rebuilds the agent", async () => {
    activateMock.mockResolvedValue({ ok: true })
    const h = harness()
    runDevmode("on 1102-AAAA-BBBB-CCCC", h)
    await flush()

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ developerMode: { enabled: true }, licenseKey: "1102AAAABBBBCCCC" }),
    )
    expect(h.agentConfigRef.current).toEqual(expect.objectContaining({ licenseKey: "1102AAAABBBBCCCC" }))
    expect(h.agentRef.current).toBeNull()
  })

  it("normalizes the pasted key instead of persisting the raw/lowercased text", async () => {
    activateMock.mockResolvedValue({ ok: true })
    const h = harness()
    runDevmode("ON   1102-abcd-efgh-jkmn  ", h)
    await flush()

    // Crockford base32 is case-insensitive on input but canonical on output:
    // config must store the 16-char uppercase form the verifier compares.
    const saved = saveMock.mock.calls[0]?.[0] as { licenseKey?: string }
    expect(saved.licenseKey).toBe("1102ABCDEFGHJKMN")
  })
})

describe("bare /devmode chooser", () => {
  it("opens an ON/OFF question and writes nothing until answered", () => {
    const h = harness({ developerMode: { enabled: false } })
    runDevmode("", h)

    expect(h.questions).toHaveLength(1)
    expect(h.questions[0]?.header).toBe("Devmode")
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("ON chains straight into the license-key prompt (no step to forget)", () => {
    const h = harness()
    runDevmode("", h)
    h.answer(["1"])

    expect(h.questions).toHaveLength(2)
    expect(h.questions[1]?.header).toBe("Devmode · License")
  })

  it("OFF disables mode, rebuilds the agent, and never prompts for a key", () => {
    const h = harness({ developerMode: { enabled: true } })
    runDevmode("", h)
    h.answer(["2"])

    expect(saveMock).toHaveBeenCalledWith({ developerMode: { enabled: false } })
    expect(h.agentRef.current).toBeNull()
    expect(h.questions).toHaveLength(1)
  })

  it("cancel changes nothing at all", () => {
    const h = harness({ developerMode: { enabled: true } })
    runDevmode("", h)
    h.answer(["3"])

    expect(saveMock).not.toHaveBeenCalled()
    expect(h.agentRef.current).toEqual({ sentinel: true })
  })
})

describe("license prompt", () => {
  it('the word "cancel" aborts instead of being treated as a key', () => {
    const h = harness()
    runDevmode("", h)
    h.answer(["1"])
    h.answer(["cancel"])

    expect(h.rows.join("\n")).toContain("Developer mode stays OFF")
    expect(activateMock).not.toHaveBeenCalled()
  })

  it("an empty answer aborts", () => {
    const h = harness()
    runDevmode("", h)
    h.answer(["1"])
    h.answer([""])

    expect(activateMock).not.toHaveBeenCalled()
  })
})

describe("configured unlock (/devmode on)", () => {
  it("refuses without a valid configured license and never enables mode", async () => {
    verifyMock.mockResolvedValue({ valid: false, reason: "expired" })
    const h = harness({ licenseKey: "1102-AAAA" })
    runDevmode("on", h)
    await flush()

    expect(h.rows.join("\n")).toContain("expired")
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("enables mode once verified", async () => {
    verifyMock.mockResolvedValue({ valid: true })
    const h = harness({ licenseKey: "1102-AAAA", developerMode: { enabled: false } })
    runDevmode("on", h)
    await flush()

    expect(saveMock).toHaveBeenCalledWith({ developerMode: { enabled: true } })
    expect(h.agentRef.current).toBeNull()
  })
})

describe("/devmode trial", () => {
  it("reports the server reason and writes nothing when no trial is available", async () => {
    trialMock.mockResolvedValue({ ok: false, reason: "machine already used its trial" })
    const h = harness()
    runDevmode("trial", h)
    await flush()

    expect(h.rows.join("\n")).toContain("machine already used its trial")
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("persists the minted key on success", async () => {
    trialMock.mockResolvedValue({ ok: true, key: "1102-TRIAL-KEY-1", days: 7 })
    const h = harness()
    runDevmode("trial", h)
    await flush()

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "1102-TRIAL-KEY-1", developerMode: { enabled: true } }),
    )
    expect(h.agentRef.current).toBeNull()
  })

  it("persists the canonical key when the server returns a lowercased copy", async () => {
    trialMock.mockResolvedValue({ ok: true, key: "1102-abcdefghjkmn", days: 7 })
    const h = harness()
    runDevmode("trial", h)
    await flush()

    // Crockford base32 is uppercase-canonical: config must store what the
    // verifier compares, never the raw wire copy.
    const saved = saveMock.mock.calls[0]?.[0] as { licenseKey?: string }
    expect(saved.licenseKey).toBe("1102ABCDEFGHJKMN")
    expect(h.agentConfigRef.current).toEqual(expect.objectContaining({ licenseKey: "1102ABCDEFGHJKMN" }))
  })
})

describe("/devmode status", () => {
  it("reports the live switches plus an invalid-license note without writing", async () => {
    verifyMock.mockResolvedValue({ valid: false, reason: "no license" })
    const h = harness({ developerMode: { enabled: true, gateEnabled: false } })
    runDevmode("status", h)
    await flush()

    const out = h.rows.join("\n")
    expect(out).toContain("Developer mode: ON")
    expect(out).toContain("Gate: OFF")
    expect(out).toContain("invalid (no license)")
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("shows an expiry date for a live-valid license", async () => {
    verifyMock.mockResolvedValue({ valid: true, plan: "pro", exp: 1_800_000_000 })
    const h = harness()
    runDevmode("status", h)
    await flush()

    expect(h.rows.join("\n")).toContain("live-valid (pro, exp 2027-01-15)")
  })
})

describe("/devmode off", () => {
  it("disables mode", () => {
    const h = harness({ developerMode: { enabled: true } })
    runDevmode("off", h)

    expect(saveMock).toHaveBeenCalledWith({ developerMode: { enabled: false } })
    expect(h.rows.join("\n")).toContain("Developer mode: OFF")
  })
})

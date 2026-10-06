/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "./config.js"

/**
 * Cheap-model config (legacy small_model/subagent_model parity).
 *
 * Overrides pass explicit "" for model/baseUrl so the file-backed user
 * config can never leak in — assertions stay hermetic. Env vars are saved
 * and restored around each case.
 */

const savedSmall = process.env.TRAYAMBAK_SMALL_MODEL
const savedSubagent = process.env.TRAYAMBAK_SUBAGENT_MODEL
const savedJudge = process.env.TRAYAMBAK_JUDGE_MODEL
const savedCompany = process.env.TRAYAMBAK_COMPANY_MODEL

afterEach(() => {
  if (savedSmall === undefined) delete process.env.TRAYAMBAK_SMALL_MODEL
  else process.env.TRAYAMBAK_SMALL_MODEL = savedSmall
  if (savedSubagent === undefined) delete process.env.TRAYAMBAK_SUBAGENT_MODEL
  else process.env.TRAYAMBAK_SUBAGENT_MODEL = savedSubagent
  if (savedJudge === undefined) delete process.env.TRAYAMBAK_JUDGE_MODEL
  else process.env.TRAYAMBAK_JUDGE_MODEL = savedJudge
  if (savedCompany === undefined) delete process.env.TRAYAMBAK_COMPANY_MODEL
  else process.env.TRAYAMBAK_COMPANY_MODEL = savedCompany
})

describe("config cheap models", () => {
  it("defaults both to undefined (parent model applies)", () => {
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })

    expect(cfg.small_model).toBeUndefined()
    expect(cfg.subagent_model).toBeUndefined()
  })

  it("accepts explicit values from overrides", () => {
    const cfg = loadConfig({
      provider: "openai",
      baseUrl: "",
      model: "",
      small_model: "gpt-4o-mini",
      subagent_model: "gpt-4o-mini",
    })

    expect(cfg.small_model).toBe("gpt-4o-mini")
    expect(cfg.subagent_model).toBe("gpt-4o-mini")
  })

  it("trims values and folds blanks to undefined", () => {
    const cfg = loadConfig({
      provider: "openai",
      baseUrl: "",
      model: "",
      small_model: "  gpt-4o-mini  ",
      subagent_model: "   ",
    })

    expect(cfg.small_model).toBe("gpt-4o-mini")
    expect(cfg.subagent_model).toBeUndefined()
  })

  it("reads TRAYAMBAK_SMALL_MODEL / TRAYAMBAK_SUBAGENT_MODEL like TRAYAMBAK_MODEL", () => {
    process.env.TRAYAMBAK_SMALL_MODEL = "tiny"
    process.env.TRAYAMBAK_SUBAGENT_MODEL = "worker"
    const cfg = loadConfig({ provider: "openai", baseUrl: "", model: "" })

    expect(cfg.small_model).toBe("tiny")
    expect(cfg.subagent_model).toBe("worker")
  })

  it("defaults judge_model to undefined and reads overrides / env like the other tiers", () => {
    expect(loadConfig({ provider: "ollama", baseUrl: "", model: "" }).judge_model).toBeUndefined()

    const cfg = loadConfig({
      provider: "ollama",
      baseUrl: "",
      model: "",
      judge_model: "  convaiinnovations/laya-multilingual  ",
    })
    expect(cfg.judge_model).toBe("convaiinnovations/laya-multilingual")

    const blank = loadConfig({ provider: "ollama", baseUrl: "", model: "", judge_model: "   " })
    expect(blank.judge_model).toBeUndefined()

    process.env.TRAYAMBAK_JUDGE_MODEL = "judge-tiny"
    const fromEnv = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(fromEnv.judge_model).toBe("judge-tiny")
  })

  it("defaults companyModel to undefined (one model does everything) and reads overrides / env", () => {
    expect(loadConfig({ provider: "ollama", baseUrl: "", model: "" }).companyModel).toBeUndefined()

    const cfg = loadConfig({ provider: "ollama", baseUrl: "", model: "", companyModel: "  worker-model  " })
    expect(cfg.companyModel).toBe("worker-model")

    const blank = loadConfig({ provider: "ollama", baseUrl: "", model: "", companyModel: "   " })
    expect(blank.companyModel).toBeUndefined()

    process.env.TRAYAMBAK_COMPANY_MODEL = "company-worker"
    const fromEnv = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(fromEnv.companyModel).toBe("company-worker")
  })
})

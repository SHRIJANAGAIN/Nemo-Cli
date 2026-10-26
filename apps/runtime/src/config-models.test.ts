/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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

const savedSmall = process.env.NEMO_SMALL_MODEL
const savedSubagent = process.env.NEMO_SUBAGENT_MODEL
const savedJudge = process.env.NEMO_JUDGE_MODEL
const savedCompany = process.env.NEMO_COMPANY_MODEL

afterEach(() => {
  if (savedSmall === undefined) delete process.env.NEMO_SMALL_MODEL
  else process.env.NEMO_SMALL_MODEL = savedSmall
  if (savedSubagent === undefined) delete process.env.NEMO_SUBAGENT_MODEL
  else process.env.NEMO_SUBAGENT_MODEL = savedSubagent
  if (savedJudge === undefined) delete process.env.NEMO_JUDGE_MODEL
  else process.env.NEMO_JUDGE_MODEL = savedJudge
  if (savedCompany === undefined) delete process.env.NEMO_COMPANY_MODEL
  else process.env.NEMO_COMPANY_MODEL = savedCompany
})

describe("config cheap models", () => {
  it("defaults both to undefined (parent model applies)", () => {
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })

    expect(cfg.small_model).toBeUndefined()
    expect(cfg.subagent_model).toBeUndefined()
  })

  it("accepts explicit values from overrides", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      small_model: "nvidia/llama-3.3-70b-instruct",
      subagent_model: "nvidia/llama-3.3-70b-instruct",
    })

    expect(cfg.small_model).toBe("nvidia/llama-3.3-70b-instruct")
    expect(cfg.subagent_model).toBe("nvidia/llama-3.3-70b-instruct")
  })

  it("trims values and folds blanks to undefined", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      small_model: "  nvidia/llama-3.3-70b-instruct  ",
      subagent_model: "   ",
    })

    expect(cfg.small_model).toBe("nvidia/llama-3.3-70b-instruct")
    expect(cfg.subagent_model).toBeUndefined()
  })

  it("reads NEMO_SMALL_MODEL / NEMO_SUBAGENT_MODEL like NEMO_MODEL", () => {
    process.env.NEMO_SMALL_MODEL = "tiny"
    process.env.NEMO_SUBAGENT_MODEL = "worker"
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })

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

    process.env.NEMO_JUDGE_MODEL = "judge-tiny"
    const fromEnv = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(fromEnv.judge_model).toBe("judge-tiny")
  })

  it("defaults companyModel to undefined (one model does everything) and reads overrides / env", () => {
    expect(loadConfig({ provider: "ollama", baseUrl: "", model: "" }).companyModel).toBeUndefined()

    const cfg = loadConfig({ provider: "ollama", baseUrl: "", model: "", companyModel: "  worker-model  " })
    expect(cfg.companyModel).toBe("worker-model")

    const blank = loadConfig({ provider: "ollama", baseUrl: "", model: "", companyModel: "   " })
    expect(blank.companyModel).toBeUndefined()

    process.env.NEMO_COMPANY_MODEL = "company-worker"
    const fromEnv = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(fromEnv.companyModel).toBe("company-worker")
  })
})

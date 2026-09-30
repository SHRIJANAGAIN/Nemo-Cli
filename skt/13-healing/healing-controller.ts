/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { runSubprocess, runPython, runShell, type SubprocessResult, type SubprocessOptions } from "./subprocess.js"
import { initScratchpad, updateScratchpad, appendAssumption, appendError, clearScratchpad } from "./scratchpad.js"
import { initJournal, logHealingEntry, getPreventionRules } from "./journal.js"
import { RollbackController } from "./rollback.js"
import { validatePatch, type AstValidationResult } from "./ast-validator.js"
import { verifyPythonCompile, verifyTypeScript, runTests, runLint, type VerificationResult } from "./verify.js"

export type PatchOperation = {
  type: "edit" | "create" | "delete"
  filePath: string
  oldContent?: string
  newContent?: string
}

export interface HealingContext {
  originalError: string
  errorLocation: string
  fileToFix: string
  language: "python" | "typescript" | "javascript"
  originalSource: string
  patches: PatchOperation[]
  assumptions: string[]
}

export interface HealingResult {
  success: boolean
  patchedFile: string | null
  validation: AstValidationResult | null
  verification: VerificationResult | null
  errors: string[]
  patch: PatchOperation | null
}

export class HealingController {
  private basePath: string
  private rollback: RollbackController
  private initialised: boolean = false

  constructor(basePath?: string) {
    this.basePath = basePath ?? process.cwd()
    this.rollback = new RollbackController(this.basePath)
  }

  async init(): Promise<void> {
    if (this.initialised) return
    initScratchpad()
    initJournal()
    this.initialised = true
  }

  async heal(ctx: HealingContext, generatePatch: () => Promise<PatchOperation | null>): Promise<HealingResult> {
    await this.init()

    appendAssumption(`Healing attempt for: ${ctx.originalError}`)
    appendAssumption(`Target file: ${ctx.fileToFix}`)
    appendAssumption(`Language: ${ctx.language}`)

    const snapshotId = this.rollback.captureSnapshot([ctx.fileToFix], "pre-healing")
    updateScratchpad({
      goal: ctx.originalError,
      targetType: "USER_CODE",
      knownFacts: ctx.assumptions,
      activeErrors: [ctx.originalError],
      invalidAssumptions: [],
      proposedPatch: "",
      timestamp: new Date().toISOString(),
      status: "active",
    })

    let attempt = 0
    const maxAttempts = 3
    const errors: string[] = []

    while (attempt < maxAttempts) {
      attempt++
      appendAssumption(`Attempt ${attempt}/${maxAttempts}`)

      const patch = await generatePatch()
      if (!patch) {
        errors.push(`Attempt ${attempt}: No patch generated`)
        appendError(`Attempt ${attempt}: No patch generated`)
        continue
      }

      const patchedSource = this.applyPatch(ctx.originalSource, patch)
      const validation = validatePatch(ctx.originalSource, patchedSource, ctx.language)

      if (!validation.valid) {
        errors.push(`Attempt ${attempt}: AST validation failed`)
        errors.push(`  New variables: ${validation.newVariablesIntroduced.join(", ")}`)
        errors.push(`  New functions: ${validation.newFunctions.join(", ")}`)
        appendError(`Attempt ${attempt}: AST validation failed: ${JSON.stringify(validation)}`)
        await this.rollback.restoreSnapshot(snapshotId)
        continue
      }

      this.writePatchedFile(ctx.fileToFix, patchedSource)

      const verification = await this.runVerification(ctx)
      if (verification && verification.passed) {
        logHealingEntry({
          bugId: "HEAL",
          targetType: "USER_CODE",
          rootCause: ctx.originalError,
          verifiedPatch: patch.newContent ?? patch.oldContent ?? "",
          preventionRule: `Validate ${ctx.language} patches with AST validator before writing to ${ctx.fileToFix}`,
          timestamp: new Date().toISOString(),
          filePath: ctx.fileToFix,
        })

        return {
          success: true,
          patchedFile: ctx.fileToFix,
          validation,
          verification,
          errors: [],
          patch,
        }
      }

      if (verification) {
        errors.push(`Attempt ${attempt}: Verification failed (exit ${verification.exitCode})`)
        if (verification.errors.length > 0) {
          errors.push(`  Errors: ${verification.errors.join("; ")}`)
        }
        appendError(`Attempt ${attempt}: Verification failed: ${JSON.stringify(verification)}`)
      }

      await this.rollback.restoreSnapshot(snapshotId)
      updateScratchpad({
        goal: ctx.originalError,
        targetType: "USER_CODE",
        knownFacts: [...ctx.assumptions, `Attempt ${attempt} failed`],
        activeErrors: [ctx.originalError, `Attempt ${attempt} failed`],
        invalidAssumptions: [],
        proposedPatch: JSON.stringify(patch),
        timestamp: new Date().toISOString(),
        status: "active",
      })
    }

    logHealingEntry({
      bugId: "HEAL",
      targetType: "USER_CODE",
      rootCause: ctx.originalError,
      verifiedPatch: "",
      preventionRule: `Manual review needed for ${ctx.fileToFix}`,
      timestamp: new Date().toISOString(),
      filePath: ctx.fileToFix,
    })

    clearScratchpad()

    return {
      success: false,
      patchedFile: null,
      validation: null,
      verification: null,
      errors,
      patch: null,
    }
  }

  private applyPatch(source: string, patch: PatchOperation): string {
    if (patch.type === "edit") {
      if (patch.oldContent && patch.newContent) {
        return source.replace(patch.oldContent, patch.newContent)
      }
    }
    if (patch.type === "create") {
      return patch.newContent ?? source
    }
    if (patch.type === "delete") {
      return ""
    }
    return source
  }

  private writePatchedFile(filePath: string, content: string): void {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.basePath, filePath)
    const dir = path.dirname(absolutePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(absolutePath, content, "utf8")
  }

  private async runVerification(ctx: HealingContext): Promise<VerificationResult | null> {
    const preventionRules = getPreventionRules()

    if (preventionRules.some((r) => r.includes("compile") || r.includes("syntax"))) {
      if (ctx.language === "python") {
        return await verifyPythonCompile(ctx.fileToFix, this.basePath)
      }
      if (ctx.language === "typescript" || ctx.language === "javascript") {
        return await verifyTypeScript(ctx.fileToFix, this.basePath)
      }
    }

    if (preventionRules.some((r) => r.includes("test"))) {
      const testFile = ctx.fileToFix.replace(/\.[^/.]+$/, ".test.ts")
      if (fs.existsSync(path.resolve(this.basePath, testFile))) {
        return await runTests(testFile, this.basePath, "jest")
      }
    }

    if (preventionRules.some((r) => r.includes("lint"))) {
      return await runLint(ctx.fileToFix, ctx.language as "python" | "typescript")
    }

    if (ctx.language === "python") {
      return await verifyPythonCompile(ctx.fileToFix, this.basePath)
    }
    if (ctx.language === "typescript" || ctx.language === "javascript") {
      return await verifyTypeScript(ctx.fileToFix, this.basePath)
    }

    return null
  }
}

export { runSubprocess, runPython, runShell, validatePatch, verifyPythonCompile, verifyTypeScript, runTests, runLint }
export type { SubprocessResult, SubprocessOptions, AstValidationResult, VerificationResult }

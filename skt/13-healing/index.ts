/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export { runSubprocess, runPython, runShell } from "./subprocess.js"
export type { SubprocessResult, SubprocessOptions } from "./subprocess.js"

export { initScratchpad, updateScratchpad, appendAssumption, appendError, clearScratchpad } from "./scratchpad.js"

export { initJournal, logHealingEntry, getPreventionRules, getPreventionRulesForTarget } from "./journal.js"
export type { JournalEntry } from "./journal.js"

export { RollbackController } from "./rollback.js"
export type { Snapshot } from "./rollback.js"

export { validatePatch, extractPythonScope, extractTypeScriptScope } from "./ast-validator.js"
export type { AstValidationResult, VariableScope } from "./ast-validator.js"

export { verifyPythonCompile, verifyTypeScript, runTests, runLint, runCustomCheck } from "./verify.js"
export type { VerificationResult } from "./verify.js"

export { HealingController } from "./healing-controller.js"
export type { HealingContext, HealingResult, PatchOperation } from "./healing-controller.js"

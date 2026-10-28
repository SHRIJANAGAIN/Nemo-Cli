/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Exec Policy module — execution policy engine.
 *
 * Provides PolicyManager, PolicyParser, ExecDecision, and .rules file support.
 * This module enforces execution policies for tool calls and commands.
 */

export { PolicyManager, PolicyParser, getPolicyManager, evaluatePolicy } from "./policy.js"
export { ExecDecision, NetworkRuleProtocol } from "./policy.js"
export type { ExecPolicyRule, NetworkRule, ExecPolicyAmendment, ExecPolicy } from "./policy.js"

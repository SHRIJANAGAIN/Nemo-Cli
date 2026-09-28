/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Exec Policy module — execution policy engine.
 *
 * Provides PolicyManager, PolicyParser, ExecDecision, and .rules file support.
 * This module enforces execution policies for tool calls and commands.
 */

export { PolicyManager, PolicyParser, getPolicyManager, evaluatePolicy } from "./policy.js"
export { ExecDecision, NetworkRuleProtocol } from "./policy.js"
export type {
    ExecPolicyRule,
    NetworkRule,
    ExecPolicyAmendment,
    ExecPolicy,
} from "./policy.js"

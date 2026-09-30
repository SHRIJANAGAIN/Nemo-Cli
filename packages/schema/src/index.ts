/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { loadConfig, type TrayambakConfig } from "../../../apps/runtime/src/index.js"

export interface ConfigError {
  field: string
  message: string
}

/** Validate a trayambak configuration, returning a list of errors (empty when valid). */
export function validateConfig(config: TrayambakConfig): ConfigError[] {
  const errors: ConfigError[] = []
  if (!config.baseUrl || !/^https?:\/\//.test(config.baseUrl)) {
    errors.push({ field: "baseUrl", message: "baseUrl must be an http(s) URL" })
  }
  if (!config.model || config.model.trim().length === 0) {
    errors.push({ field: "model", message: "model must be a non-empty name" })
  }
  if (config.temperature < 0 || config.temperature > 2) {
    errors.push({ field: "temperature", message: "temperature must be between 0 and 2" })
  }
  if (config.maxTokens <= 0) {
    errors.push({ field: "maxTokens", message: "maxTokens must be positive" })
  }
  return errors
}

export function assertConfig(config: TrayambakConfig): void {
  const errors = validateConfig(config)
  if (errors.length > 0) {
    throw new Error("Invalid configuration: " + errors.map((e) => `${e.field}: ${e.message}`).join("; "))
  }
}

export { loadConfig }

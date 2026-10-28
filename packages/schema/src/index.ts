/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadConfig, type NemoConfig } from "../../../apps/runtime/src/index.js"

export interface ConfigError {
  field: string
  message: string
}

/** Validate a nemo configuration, returning a list of errors (empty when valid). */
export function validateConfig(config: NemoConfig): ConfigError[] {
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

export function assertConfig(config: NemoConfig): void {
  const errors = validateConfig(config)
  if (errors.length > 0) {
    throw new Error("Invalid configuration: " + errors.map((e) => `${e.field}: ${e.message}`).join("; "))
  }
}

export { loadConfig }

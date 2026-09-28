/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** Required-args validation for tool calls (honest input guard). */

export function validateToolUse(name: string, args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    const v = args[key]
    if (typeof v !== "string" || v.trim().length === 0) {
      return `tool '${name}' missing required '${key}'`
    }
  }
  return null
}

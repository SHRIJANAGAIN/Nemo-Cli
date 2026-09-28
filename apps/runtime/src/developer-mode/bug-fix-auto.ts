/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
export function shouldAutoSpawnBugFix(eventType: string, errorCount: number): boolean {
  if (eventType === "tool_error" && errorCount >= 2) return true
  if (eventType === "permission_denied") return true
  if (eventType === "tui_error") return true
  return false
}
export function bugFixTaskLabel(toolName: string, error: string): string {
  return "[bug-fix] " + toolName + ": " + error.slice(0, 200)
}

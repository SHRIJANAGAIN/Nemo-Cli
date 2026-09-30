/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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

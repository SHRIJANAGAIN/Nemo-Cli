/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Vendored stand-in for `@claude-code/output/utils/stringUtils.js`
 * (registry E404). Only `countCharInString` is consumed — by the vim
 * operators to count newlines before the cursor (line/column math).
 */

export function countCharInString(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || needle.length === 0) return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}

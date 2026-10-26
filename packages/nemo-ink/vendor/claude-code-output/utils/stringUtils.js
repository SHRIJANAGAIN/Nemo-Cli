/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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

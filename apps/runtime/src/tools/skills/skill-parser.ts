/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

const MAX_NAME_LEN = 64

export function sanitizeSingleLine(raw: string): string {
  return raw.split(/\s+/).join(" ")
}

export function repairFrontmatterScalarFields(frontmatter: string): string | null {
  const lines = frontmatter.split("\n")
  const repaired: string[] = []
  let changed = false
  let blockScalarIndent: number | undefined

  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    if (blockScalarIndent !== undefined) {
      if (trimmed.length === 0 || indent > blockScalarIndent) {
        repaired.push(line)
        continue
      }
      blockScalarIndent = undefined
    }

    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) {
      repaired.push(line)
      continue
    }

    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1)
    const trimmedStart = value.trimStart()
    const leadingWhitespace = value.slice(0, value.length - trimmedStart.length)
    let scalar = trimmedStart
    let comment = ""

    for (const [index, character] of [...trimmedStart].entries()) {
      if (character === "#" && (index === 0 || /\s/.test(trimmedStart[index - 1]))) {
        scalar = trimmedStart.slice(0, index).trimEnd()
        comment = trimmedStart.slice(index)
        break
      }
    }

    const firstChar = scalar.charAt(0)
    if (firstChar === "|" || firstChar === ">") {
      blockScalarIndent = indent
      repaired.push(line)
      continue
    }
    if (firstChar === "'" || firstChar === '"') {
      repaired.push(line)
      continue
    }

    const hasColonSeparator = [...scalar].some((c, i, arr) => c === ":" && i + 1 < arr.length && /\s/.test(arr[i + 1]))
    const invalidFlowLikeScalar = /[\[{@`]/.test(firstChar) && !isValidFlowScalar(scalar)
    if (!hasColonSeparator && !invalidFlowLikeScalar) {
      repaired.push(line)
      continue
    }

    const quotedScalar = "'" + scalar.replace(/'/g, "''") + "'"
    repaired.push(`${key}:${leadingWhitespace}${quotedScalar}${comment}`)
    changed = true
  }

  return changed ? repaired.join("\n") : null
}

function isValidFlowScalar(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

export function validateSkillFrontmatter(parsed: {
  name?: string
  description?: string
  shortDescription?: string
  model?: unknown
}): string | null {
  const name = sanitizeSingleLine(parsed.name ?? "")
  if (!name) return "missing field `name`"
  if (name.length > MAX_NAME_LEN) return `invalid name: exceeds ${MAX_NAME_LEN} characters`
  const description = sanitizeSingleLine(parsed.description ?? "")
  if (!description) return "missing field `description`"
  if (parsed.shortDescription !== undefined && typeof parsed.shortDescription !== "string") {
    return "invalid short-description: must be a string"
  }
  if (parsed.model !== undefined && !isValidSkillModel(parsed.model)) {
    return "invalid model: must be a string or object"
  }
  return null
}

function isValidSkillModel(value: unknown): boolean {
  if (typeof value === "string") return true
  if (!value || typeof value !== "object") return false
  return true
}

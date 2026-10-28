/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tool-argument validation against the schema the tool already declares.
 *
 * The gap this closes: 79 tools declare `parameters.properties` and `required`,
 * and 27 use `enum`, and every one of those schemas is sent to the model so the
 * model knows what to emit — but NOTHING validated the arguments on the way
 * back. A model that emitted `{"path": 42}` for a tool expecting a string got
 * the failure deep inside the tool body: a `path.resolve` that produced
 * `.../undefined`, or a `fs.readFile` ENOENT naming a file that never existed.
 * The model then saw "no such file" and "fixed" it by trying another path, when
 * the real problem was the argument TYPE.
 *
 * Validating at the boundary turns that into a message naming the field, the
 * expected type, and what arrived — which a model can act on in one turn.
 *
 * Deliberately scoped to the vocabulary `ToolParameterProperty` actually
 * declares (type, description, enum, items) rather than implementing JSON
 * Schema. A partial validator that matches the declared contract beats a
 * complete one nobody trusts, because the failure mode of the latter is silently
 * accepting input it claims to check.
 */

export type ParamType = "string" | "number" | "integer" | "boolean" | "array" | "object"

export interface ParamProperty {
  type: ParamType
  description?: string
  enum?: string[]
  items?: ParamProperty
  /** Extra bounds honoured when present. Not part of the protocol type, but a
   *  tool may attach them and validation should not ignore them. */
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

export interface ParamSchema {
  type: "object"
  properties: Record<string, ParamProperty>
  required: string[]
}

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `content[2]` or `a.b`. */
  path: string
  /** Machine-readable reason. */
  code:
    | "missing-required"
    | "wrong-type"
    | "not-enum-member"
    | "below-minimum"
    | "above-maximum"
    | "too-short"
    | "too-long"
    | "too-few-items"
    | "too-many-items"
    | "null-not-allowed"
    | "array-item-invalid"
  /** Human-readable, addressed to the MODEL so it can self-correct. */
  message: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

const OK: ValidationResult = { valid: true, issues: [] }

function ok(): ValidationResult {
  return OK
}

/**
 * Describe a value's JSON type in words a model can act on.
 *
 * `Array.isArray` matters: `typeof []` is "object", so an array sent where a
 * string was expected otherwise reports "expected string, got object", which
 * sends the model looking in the wrong place entirely.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function matchesType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "array":
      return Array.isArray(value)
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
    default:
      // An unknown type keyword must NOT reject: a tool declaring something this
      // build does not understand should still run rather than become unusable.
      return true
  }
}

function typeLabel(type: ParamType): string {
  return type === "integer" ? "an integer" : `a ${type}`
}

function joinPath(prefix: string, key: string | number): string {
  if (typeof key === "number") return `${prefix}[${key}]`
  return prefix.length === 0 ? key : `${prefix}.${key}`
}

/** Depth cap, so a self-referential schema cannot blow the stack. */
const MAX_DEPTH = 12

function validateValue(
  value: unknown,
  schema: ParamProperty,
  path: string,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return

  if (value === null) {
    // `null` is not a valid value for any declared type. Reported distinctly
    // because `typeof null === "object"` would otherwise make a null satisfy an
    // "object" parameter and reach the tool as a hole.
    issues.push({
      path,
      code: "null-not-allowed",
      message: `${path.length > 0 ? path : "argument"} must not be null`,
    })
    return
  }

  if (!matchesType(value, schema.type)) {
    issues.push({
      path,
      code: "wrong-type",
      message: `${path.length > 0 ? path : "argument"} must be ${typeLabel(schema.type)}, but received ${jsonTypeOf(value)}`,
    })
    return
  }

  if (schema.enum !== undefined && schema.enum.length > 0) {
    // Only meaningful for strings; an enum on a number type is not something the
    // protocol type allows, so skipping it is safer than coercing.
    if (typeof value === "string" && !schema.enum.includes(value)) {
      issues.push({
        path,
        code: "not-enum-member",
        message: `${path} must be one of ${schema.enum.map((v) => `"${v}"`).join(", ")}, but received "${value}"`,
      })
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({
        path,
        code: "below-minimum",
        message: `${path} must be >= ${schema.minimum}, but received ${value}`,
      })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({
        path,
        code: "above-maximum",
        message: `${path} must be <= ${schema.maximum}, but received ${value}`,
      })
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({
        path,
        code: "too-short",
        message: `${path} must be at least ${schema.minLength} character(s), but received ${value.length}`,
      })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        code: "too-long",
        message: `${path} must be at most ${schema.maxLength} character(s), but received ${value.length}`,
      })
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({
        path,
        code: "too-few-items",
        message: `${path} must have at least ${schema.minItems} item(s), but received ${value.length}`,
      })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({
        path,
        code: "too-many-items",
        message: `${path} must have at most ${schema.maxItems} item(s), but received ${value.length}`,
      })
    }
    // Item validation is best-effort and BOUNDED: a model that emitted a 100k
    // array must not turn validation into the thing that hangs the turn. Only
    // the first few items are checked and the omission is not reported.
    const items = schema.items
    if (items !== undefined) {
      const limit = Math.min(value.length, 50)
      for (let i = 0; i < limit; i++) {
        validateValue(value[i], items, joinPath(path, i), issues, depth + 1)
        // Stop early once enough issues exist to tell the model it got it wrong.
        if (issues.length >= 10) break
      }
    }
  }
}

/**
 * Validate a tool-call argument object against its declared schema.
 *
 * `args` is `unknown` rather than `Record<string, unknown>` because the value
 * arriving from a model's tool call is untrusted by definition — typing it as a
 * record would be a lie that removes the check this function exists to perform.
 */
export function validateToolArguments(schema: ParamSchema, args: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (args === null || args === undefined) {
    // A missing object is only an error when something is required. A tool with
    // no required parameters may legitimately be called with no arguments.
    if (schema.required.length === 0) return ok()
    return {
      valid: false,
      issues: schema.required.map((name) => ({
        path: name,
        code: "missing-required" as const,
        message: `missing required argument "${name}"`,
      })),
    }
  }

  if (typeof args !== "object" || Array.isArray(args)) {
    return {
      valid: false,
      issues: [
        {
          path: "",
          code: "wrong-type",
          message: `arguments must be an object, but received ${jsonTypeOf(args)}`,
        },
      ],
    }
  }

  const record = args as Record<string, unknown>

  for (const name of schema.required) {
    // A key present with an explicit `undefined` counts as absent: JSON has no
    // undefined, so this can only come from a hand-built call, and treating it as
    // present would push `undefined` into the tool body.
    if (!(name in record) || record[name] === undefined) {
      issues.push({
        path: name,
        code: "missing-required",
        message: `missing required argument "${name}"`,
      })
    }
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!(name in record)) continue
    const value = record[name]
    if (value === undefined) continue
    validateValue(value, property, name, issues, 0)
  }

  // Unknown keys are NOT an error. Several providers echo back extra fields, and
  // strict rejection would break tools that are otherwise correct. Anything the
  // tool does not read is simply ignored by it.
  if (issues.length === 0) return ok()
  return { valid: false, issues }
}

/** Convenience: true when the arguments satisfy the schema. */
export function isValidArguments(schema: ParamSchema, args: unknown): boolean {
  return validateToolArguments(schema, args).valid
}

const TRUE_WORDS = new Set(["true", "yes", "on", "1"])
const FALSE_WORDS = new Set(["false", "no", "off", "0"])

function coerceValue(value: unknown, schema: ParamProperty): unknown {
  if (typeof value === "string") {
    // Models routinely spell booleans as `"False"` / `"true"`. Rejecting that
    // costs a whole turn and the model usually re-sends the same string.
    if (schema.type === "boolean") {
      const word = value.trim().toLowerCase()
      if (TRUE_WORDS.has(word)) return true
      if (FALSE_WORDS.has(word)) return false
      return value
    }
    if (schema.type === "number" || schema.type === "integer") {
      const trimmed = value.trim()
      if (trimmed.length === 0) return value
      const num = Number(trimmed)
      if (!Number.isFinite(num)) return value
      if (schema.type === "integer" && !Number.isInteger(num)) return value
      return num
    }
    // An object/array argument sent as a JSON string is the same mistake one
    // level up; parsing it is unambiguous, unlike guessing at partial JSON.
    if ((schema.type === "object" || schema.type === "array") && /^[[{]/.test(value.trim())) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (schema.type === "object" && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed
        }
        if (schema.type === "array" && Array.isArray(parsed)) return parsed
      } catch {
        /* leave the string for validation to report */
      }
    }
    return value
  }
  if (schema.type === "array" && schema.items !== undefined && Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const coerced = coerceValue(item, schema.items!)
      if (coerced !== item) changed = true
      return coerced
    })
    return changed ? out : value
  }
  return value
}

/**
 * Normalise scalar arguments that are unambiguous strings of the declared type
 * (`"False"` → `false`, `"30"` → 30, JSON-string object/array → parsed).
 *
 * Only DECLARED properties are touched, and the original object is returned
 * untouched when nothing changed — a model's `{"path": "a.ts"}` must reach the
 * tool exactly as sent. Ambiguous strings are left for validation to reject,
 * so `"maybe"` for a boolean still produces a corrective message rather than a
 * silent wrong value.
 */
export function coerceToolArguments(schema: ParamSchema, args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!(name in record)) continue
    const value = record[name]
    if (value === undefined) continue
    const coerced = coerceValue(value, property)
    if (coerced === value) continue
    if (out === undefined) out = { ...record }
    out[name] = coerced
  }
  return out ?? args
}

/**
 * Render issues as ONE model-facing line.
 *
 * The cap matters: a tool with twelve required parameters produced twelve
 * sentences, which is a wall of text that crowds the actual reply out of the
 * context window. Three named failures is enough for a model to re-issue.
 */
export function formatValidationIssues(issues: readonly ValidationIssue[], max = 3): string {
  if (issues.length === 0) return ""
  const shown = issues.slice(0, max).map((issue) => issue.message)
  if (issues.length > shown.length) {
    shown.push(`(and ${issues.length - shown.length} more argument problem(s))`)
  }
  return `Invalid arguments: ${shown.join("; ")}`
}

/**
 * Validate and coerce the common string-or-string[] argument shape.
 *
 * Several tools accept `files` as either a single path or a list, and the model
 * uses both spellings freely. Returning a normalised array removes a whole class
 * of tool-side branching, and the failure is reported as a validation issue so
 * the model sees the same message shape as any other bad argument.
 */
export function coerceStringList(
  value: unknown,
  options: { field: string; max?: number } = { field: "value" },
): { ok: true; values: string[] } | { ok: false; message: string } {
  const { field, max } = options
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length === 0) return { ok: false, message: `${field} must not be empty` }
    if (max !== undefined && 1 > max) {
      return { ok: false, message: `${field} may contain at most ${max} item(s)` }
    }
    return { ok: true, values: [trimmed] }
  }
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== "string") {
        return { ok: false, message: `${field} must contain only strings, but it contains a ${jsonTypeOf(item)}` }
      }
      const trimmed = item.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
    if (out.length === 0) return { ok: false, message: `${field} must contain at least one non-empty string` }
    if (max !== undefined && out.length > max) {
      return { ok: false, message: `${field} may contain at most ${max} item(s), but received ${out.length}` }
    }
    return { ok: true, values: out }
  }
  return {
    ok: false,
    message: `${field} must be a string or an array of strings, but received ${jsonTypeOf(value)}`,
  }
}

/**
 * Normalise a tool schema coming from a provider, which may express `required`
 * as absent or as a non-array.
 *
 * A malformed schema must not make a tool permanently unusable: an absent
 * `required` is treated as "nothing required" rather than throwing at
 * registration time, so the tool still runs and its own body reports what it
 * actually needed.
 */
export function normalizeSchema(raw: unknown): ParamSchema {
  const fallback: ParamSchema = { type: "object", properties: {}, required: [] }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback

  const record = raw as Record<string, unknown>
  const properties: Record<string, ParamProperty> = {}
  const rawProperties = record.properties
  if (rawProperties !== null && typeof rawProperties === "object" && !Array.isArray(rawProperties)) {
    for (const [name, value] of Object.entries(rawProperties as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue
      const prop = value as Record<string, unknown>
      const type = typeof prop.type === "string" ? (prop.type as ParamType) : "string"
      const entry: ParamProperty = { type }
      if (typeof prop.description === "string") entry.description = prop.description
      if (Array.isArray(prop.enum)) entry.enum = prop.enum.filter((v): v is string => typeof v === "string")
      if (prop.items !== null && typeof prop.items === "object" && !Array.isArray(prop.items)) {
        entry.items = normalizeSchemaProperty(prop.items as Record<string, unknown>)
      }
      for (const bound of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
        const value2 = prop[bound]
        if (typeof value2 === "number" && Number.isFinite(value2)) entry[bound] = value2
      }
      properties[name] = entry
    }
  }

  const required = Array.isArray(record.required)
    ? record.required.filter((v): v is string => typeof v === "string" && properties[v] !== undefined)
    : []

  return { type: "object", properties, required }
}

function normalizeSchemaProperty(raw: Record<string, unknown>): ParamProperty {
  const type = typeof raw.type === "string" ? (raw.type as ParamType) : "string"
  const entry: ParamProperty = { type }
  if (Array.isArray(raw.enum)) entry.enum = raw.enum.filter((v): v is string => typeof v === "string")
  if (raw.items !== null && typeof raw.items === "object" && !Array.isArray(raw.items)) {
    entry.items = normalizeSchemaProperty(raw.items as Record<string, unknown>)
  }
  return entry
}
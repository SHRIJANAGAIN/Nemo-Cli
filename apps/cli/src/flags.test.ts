import { describe, expect, it } from "vitest"
import { parseFlags, portValue } from "./flags.js"

const KNOWN = new Set(["port", "model", "m", "dev", "prompt", "p", "session"])
const TYPES = new Map<string, "string" | "boolean">([
  ["port", "string"],
  ["model", "string"],
  ["m", "string"],
  ["dev", "boolean"],
  ["prompt", "string"],
  ["p", "string"],
  ["session", "string"],
])

describe("parseFlags (lenient)", () => {
  it("parses --key=value", () => {
    expect(parseFlags(["--port=8787"]).flags.port).toBe("8787")
  })
  it("parses --no-foo to false", () => {
    expect(parseFlags(["--no-ink"]).flags.ink).toBe("false")
  })
  it("parses --key value", () => {
    const r = parseFlags(["--model", "gpt-x"])
    expect(r.flags.model).toBe("gpt-x")
    expect(r.positional).toEqual([])
  })
  it("marks valueless flags as true", () => {
    expect(parseFlags(["--verbose"]).flags.verbose).toBe("true")
  })
  it("does not consume a following flag as a value", () => {
    const r = parseFlags(["--dev", "--model", "x"])
    expect(r.flags.dev).toBe("true")
    expect(r.flags.model).toBe("x")
  })
  it("maps -p/-m/-c shorthand", () => {
    const r = parseFlags(["-p", "hello", "-m", "m1", "-c", "/tmp"])
    expect(r.flags.prompt).toBe("hello")
    expect(r.flags.model).toBe("m1")
    expect(r.flags.cwd).toBe("/tmp")
  })
  it("maps -h/-v shorthand to help/version", () => {
    expect(parseFlags(["-h"]).flags.help).toBe("true")
    expect(parseFlags(["-v"]).flags.version).toBe("true")
  })
  it("collects positionals and preserves order", () => {
    const r = parseFlags(["one", "two"])
    expect(r.positional).toEqual(["one", "two"])
  })
  it("legacy: an unknown valueless flag swallows the next token (documented behavior)", () => {
    const r = parseFlags(["one", "--flag", "two"])
    expect(r.positional).toEqual(["one"])
    expect(r.flags.flag).toBe("two")
  })
})

describe("parseFlags (strict)", () => {
  it("reports unknown long flags", () => {
    const r = parseFlags(["--bogus", "1"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.unknown).toContain("--bogus")
    expect(r.errors.some((e) => e.includes("unknown flag: --bogus"))).toBe(true)
  })
  it("reports unknown --no- variants", () => {
    const r = parseFlags(["--no-bogus"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.errors.some((e) => e.includes("--no-bogus"))).toBe(true)
  })
  it("accepts known flags without errors", () => {
    const r = parseFlags(["--port", "8080", "--dev"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.errors).toEqual([])
    expect(r.flags.port).toBe("8080")
    expect(r.flags.dev).toBe("true")
  })
  it("accepts aliases and canonicalizes them", () => {
    const ALIASES = new Map([
      ["m", "model"],
      ["p", "prompt"],
    ])
    const r = parseFlags(["-p", "hi", "--m", "model-a"], {
      known: KNOWN,
      types: TYPES,
      aliasMap: ALIASES,
      strict: true,
    })
    expect(r.errors).toEqual([])
    expect(r.flags.prompt).toBe("hi")
    expect(r.flags.model).toBe("model-a")
    expect(r.flags.m).toBeUndefined()
  })
  it("errors when a string flag has no value", () => {
    const r = parseFlags(["--port"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.errors.some((e) => e.includes("--port requires a value"))).toBe(true)
  })
  it("does not consume a value for boolean flags", () => {
    const r = parseFlags(["--dev", "true"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.flags.dev).toBe("true")
    expect(r.positional).toEqual(["true"])
  })
  it("still parses unknown flags leniently downstream", () => {
    const r = parseFlags(["--bogus", "7"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.flags.bogus).toBe("7")
    expect(r.errors.length).toBeGreaterThan(0)
  })
  it("reports missing value for -p shorthand", () => {
    const r = parseFlags(["-p"], { known: KNOWN, types: TYPES, strict: true })
    expect(r.errors.some((e) => e.includes("-p requires a value"))).toBe(true)
  })
})

describe("portValue", () => {
  it("accepts valid ports", () => {
    expect(portValue("1")).toBe(1)
    expect(portValue("8787")).toBe(8787)
    expect(portValue("65535")).toBe(65535)
  })
  it("rejects invalid values", () => {
    expect(portValue("0")).toBeNull()
    expect(portValue("65536")).toBeNull()
    expect(portValue("-1")).toBeNull()
    expect(portValue("abc")).toBeNull()
    expect(portValue("80.5")).toBeNull()
    expect(portValue("")).toBeNull()
    expect(portValue(undefined)).toBeNull()
    expect(portValue("true")).toBeNull()
  })
})

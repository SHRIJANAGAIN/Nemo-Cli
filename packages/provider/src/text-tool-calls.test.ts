import { describe, expect, it } from "vitest"
import { extractTextToolCalls } from "./index.js"

describe("extractTextToolCalls", () => {
  it("parses the JSON body dialect", () => {
    const r = extractTextToolCalls('<tool_call>{"name":"glob","arguments":{"pattern":"**/*.ts"}}</tool_call>')
    expect(r.toolCalls).toMatchObject([{ type: "toolCall", name: "glob", arguments: { pattern: "**/*.ts" } }])
    expect(r.toolCalls[0]!.id).toMatch(/^call_/)
    expect(r.prose).toBe("")
  })

  it("parses the XML dialect with typed parameter values", () => {
    const text = [
      "I'll look around first.",
      "<tool_call>",
      "<function=list_dir>",
      "<parameter=path>",
      "src",
      "</parameter>",
      "<parameter=depth>",
      "2",
      "</parameter>",
      "<parameter=follow>",
      "true",
      "</parameter>",
      "</function>",
      "</tool_call>",
    ].join("\n")
    const r = extractTextToolCalls(text)
    expect(r.toolCalls).toMatchObject([
      { type: "toolCall", name: "list_dir", arguments: { path: "src", depth: 2, follow: true } },
    ])
    expect(r.prose).toBe("I'll look around first.")
  })

  it("parses multiple XML blocks and keeps text without tags", () => {
    const text =
      "<tool_call>\n<function=glob>\n<parameter=pattern>\n**/snake.py\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=list_dir>\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>"
    const r = extractTextToolCalls(text)
    expect(r.toolCalls.map((c) => [c.name, c.arguments])).toEqual([
      ["glob", { pattern: "**/snake.py" }],
      ["list_dir", { path: "." }],
    ])
  })

  it("keeps an unparseable block visible instead of dropping it", () => {
    const r = extractTextToolCalls("<tool_call>not json</tool_call>")
    expect(r.toolCalls).toHaveLength(0)
    expect(r.prose).toContain("not json")
  })

  it("never reuses a call id across responses", () => {
    const fence = '<tool_call>{"name":"glob","arguments":{}}</tool_call>'
    const ids = [
      ...extractTextToolCalls(fence).toolCalls,
      ...extractTextToolCalls(fence).toolCalls,
      ...extractTextToolCalls(fence).toolCalls,
    ].map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("parses nested opens that share a single closing tag", () => {
    const text = [
      "<tool_call>",
      '{ "name": "list_dir", "arguments": { "path": "." } }',
      "<tool_call>",
      '{ "name": "bash", "arguments": { "command": "ls -la" } }',
      "</tool_call>",
    ].join("\n")
    const r = extractTextToolCalls(text)
    expect(r.toolCalls.map((c) => [c.name, c.arguments])).toEqual([
      ["list_dir", { path: "." }],
      ["bash", { command: "ls -la" }],
    ])
    expect(r.prose).toBe("")
  })

  it("parses a fence the model never closed", () => {
    const r = extractTextToolCalls('Working on it.\n<tool_call>\n{"name":"glob","arguments":{"pattern":"*.ts"}}')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.name).toBe("glob")
    expect(r.prose).toBe("Working on it.")
  })
})

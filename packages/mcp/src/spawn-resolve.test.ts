/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as path from "path"
import {
  canSpawnDirectly,
  resolveExecutable,
  resolveMcpCommand,
  resolveNpmCliJs,
  resolveNpxCliJs,
} from "./spawn-resolve.js"

describe("spawn-resolve", () => {
  it("resolves node to the running binary", () => {
    const bin = resolveExecutable("node")
    expect(bin).toBeDefined()
    expect(path.isAbsolute(bin as string)).toBe(true)
    expect(resolveExecutable("definitely-not-a-binary-xyz-123")).toBeUndefined()
  })

  it("finds npm/npx entries next to node", () => {
    expect(resolveNpmCliJs()?.endsWith("npm-cli.js")).toBe(true)
    expect(resolveNpxCliJs()?.endsWith("npx-cli.js")).toBe(true)
  })

  it("rewrites npx specs to node + npx-cli.js", () => {
    const resolved = resolveMcpCommand(["npx", "-y", "@modelcontextprotocol/server-puppeteer"])
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args[0]?.endsWith("npx-cli.js")).toBe(true)
    expect(resolved.args).toContain("-y")
  })

  it("pins node specs to the running binary", () => {
    const resolved = resolveMcpCommand(["node", "server.js"])
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args).toEqual(["server.js"])
  })

  it("rejects empty commands with a readable error", () => {
    expect(() => resolveMcpCommand([])).toThrow(/empty command/)
  })

  it("passes unknown commands through for downstream diagnostics", () => {
    expect(resolveMcpCommand(["definitely-not-a-binary-xyz-123", "--x"])).toEqual({
      command: "definitely-not-a-binary-xyz-123",
      args: ["--x"],
    })
  })

  it("rewrites npm specs to node + npm-cli.js (never a .cmd shim)", () => {
    // A bare spawn of npm.cmd throws spawn EINVAL under shell:false (DEP0190).
    const resolved = resolveMcpCommand(["npm", "run", "serve"])
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args[0]?.endsWith("npm-cli.js")).toBe(true)
    expect(resolved.args.slice(1)).toEqual(["run", "serve"])
  })

  it("classifies only native executables as directly spawnable on Windows", () => {
    expect(canSpawnDirectly(path.join("C:", "x", "node.exe"))).toBe(true)
    // *.cmd = EINVAL, extensionless POSIX shim = ENOENT — both fine on POSIX.
    expect(canSpawnDirectly(path.join("C:", "x", "npm.cmd"))).toBe(process.platform !== "win32")
    expect(canSpawnDirectly(path.join("C:", "x", "npm"))).toBe(process.platform !== "win32")
  })
})

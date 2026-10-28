/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import {
  detectBackend,
  describeEnforcement,
  checkFileOp,
  checkExecPolicyAll,
  DEFAULT_EXEC_RULES,
} from "../../../../packages/sandbox/src/index.js"
import { EXIT_DENIED, EXIT_USAGE } from "../command-registry.js"

export function sandboxCommand(args: string[]): string {
  const backend = detectBackend()
  const enforcement = describeEnforcement(backend)
  if (args[0] === "check" && args[1]) {
    const r = checkFileOp({ type: "workspace-write", writableRoots: ["."] }, "write", args[1], process.cwd())
    return `${r.allowed ? "allow" : "deny"} (${r.backend}, ${r.enforcement})${r.reason ? `: ${r.reason}` : ""}`
  }
  return [
    `backend: ${backend}`,
    enforcement === "os-sandbox"
      ? `enforcement: os-sandbox (bash runs spawn under ${backend} while the sandboxSpawn flag is on)`
      : `enforcement: policy-only (in-process policy evaluation — no OS sandbox is spawned)`,
    "Usage: nemo sandbox check <file>",
  ].join("\n")
}

export function execpolicyCommand(args: string[]): string {
  if (args[0] === "check" && args[1]) {
    const cmd = args.slice(1).join(" ")
    const r = checkExecPolicyAll(cmd, DEFAULT_EXEC_RULES)
    // CI-gatable outcomes (mcp.ts precedent: commands own their exit code):
    // deny → 3 (the check ran, the answer is no), allow leaves 0.
    if (!r.allowed) process.exitCode = EXIT_DENIED
    return r.allowed ? "allow" : `deny (${r.rule?.pattern})`
  }
  process.exitCode = EXIT_USAGE
  return "Usage: nemo execpolicy check <command>"
}

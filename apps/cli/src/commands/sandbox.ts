/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import {
  detectBackend,
  enforcementFor,
  checkFileOp,
  checkExecPolicy,
  DEFAULT_EXEC_RULES,
} from "../../../../packages/sandbox/src/index.js"

export function sandboxCommand(args: string[]): string {
  const backend = detectBackend()
  const enforcement = enforcementFor(backend)
  if (args[0] === "check" && args[1]) {
    const r = checkFileOp({ type: "workspace-write", writableRoots: ["."] }, "write", args[1], process.cwd())
    return `${r.allowed ? "allow" : "deny"} (${r.backend}, ${r.enforcement})${r.reason ? `: ${r.reason}` : ""}`
  }
  return [
    `backend: ${backend}`,
    `enforcement: ${enforcement} (in-process policy evaluation — no OS sandbox is spawned)`,
    "Usage: trayambak sandbox check <file>",
  ].join("\n")
}

export function execpolicyCommand(args: string[]): string {
  if (args[0] === "check" && args[1]) {
    const cmd = args.slice(1).join(" ")
    const r = checkExecPolicy(cmd, DEFAULT_EXEC_RULES)
    return r.allowed ? "allow" : `deny (${r.rule?.pattern})`
  }
  return "Usage: trayambak execpolicy check <command>"
}

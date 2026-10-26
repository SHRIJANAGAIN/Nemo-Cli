/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn, type SpawnOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"

export interface SubprocessResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  signal?: string
  durationMs: number
}

export interface SubprocessOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT = 30000
const DEFAULT_CWD = process.cwd()

export async function runSubprocess(
  cmd: string,
  args: string[],
  opts: SubprocessOptions = {},
): Promise<SubprocessResult> {
  const cwd = opts.cwd ?? DEFAULT_CWD
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const env = opts.env ?? process.env

  const startTime = Date.now()
  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd,
      env,
      signal: opts.signal,
      windowsHide: true,
    }

    let stdout = ""
    let stderr = ""
    let childProcess: ReturnType<typeof spawn> | null = null

    try {
      childProcess = spawn(cmd, args, spawnOpts)
    } catch (err) {
      reject(err)
      return
    }

    if (!childProcess) {
      reject(new Error("Failed to spawn process"))
      return
    }

    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8")
    })

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8")
    })

    killTimer = setTimeout(() => {
      timedOut = true
      childProcess?.kill("SIGTERM")
      setTimeout(() => childProcess?.kill("SIGKILL"), 5000)
    }, timeoutMs)

    childProcess.on("error", (err: Error) => {
      clearTimeout(killTimer!)
      reject(err)
    })

    childProcess.on("exit", (code: number | null, signal: string | null) => {
      clearTimeout(killTimer!)
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (signal ? -1 : 0),
        timedOut,
        signal: signal ?? undefined,
        durationMs: Date.now() - startTime,
      })
    })

    opts.signal?.addEventListener(
      "abort",
      () => {
        if (!timedOut) {
          timedOut = true
          childProcess?.kill("SIGTERM")
          setTimeout(() => childProcess?.kill("SIGKILL"), 5000)
        }
      },
      { once: true },
    )
  })
}

export async function runPython(
  script: string,
  args: string[] = [],
  opts: SubprocessOptions = {},
): Promise<SubprocessResult> {
  const scriptPath = path.join(opts.cwd ?? DEFAULT_CWD, ".tmp_healing_script.py")
  fs.writeFileSync(scriptPath, script, "utf8")
  try {
    return await runSubprocess("python", [scriptPath, ...args], opts)
  } finally {
    try {
      fs.unlinkSync(scriptPath)
    } catch {
      /* ignore */
    }
  }
}

export async function runShell(command: string, opts: SubprocessOptions = {}): Promise<SubprocessResult> {
  const shell = process.platform === "win32" ? "cmd.exe" : "bash"
  const flag = process.platform === "win32" ? "/c" : "-c"
  return runSubprocess(shell, [flag, command], opts)
}

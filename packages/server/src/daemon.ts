/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** App-server daemon lifecycle (pid file in ~/.trayambak). */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"

function pidFile(): string {
  return path.join(os.homedir(), ".trayambak", "app-server.pid")
}

export function daemonStatus(): string {
  const f = pidFile()
  if (!fs.existsSync(f)) return "stopped"
  try {
    const pid = Number(fs.readFileSync(f, "utf8").trim())
    process.kill(pid, 0)
    return `running (pid ${pid})`
  } catch {
    return "stale"
  }
}

export function daemonStart(port = 8787): string {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "apps", "cli", "src", "index.js"), "web", "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  )
  child.unref()
  fs.mkdirSync(path.dirname(pidFile()), { recursive: true })
  fs.writeFileSync(pidFile(), String(child.pid ?? 0), "utf8")
  return `started (pid ${child.pid ?? 0}) on :${port}`
}

export function daemonStop(): string {
  const f = pidFile()
  if (!fs.existsSync(f)) return "not running"
  try {
    const pid = Number(fs.readFileSync(f, "utf8").trim())
    process.kill(pid, "SIGTERM")
  } catch {
    /* already dead */
  }
  fs.rmSync(f, { force: true })
  return "stopped"
}

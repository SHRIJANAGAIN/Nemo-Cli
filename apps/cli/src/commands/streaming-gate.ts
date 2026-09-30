/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as child from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as readline from "readline"

export interface GateConfig {
  consecutiveRun: number
  ngramRepeat: number
  sentenceMin: number
  unverifiedClaim: number
}

export interface GateDecision {
  decision: "continue" | "cut" | "retry"
  reason: string
  level: string
  cutAtChar: number
  charPos: number
  totalChars: number
  details: Record<string, unknown>
}

export interface VerifyReport {
  steps: Array<{
    name: string
    command: string
    status: "pass" | "fail" | "skip" | "error"
    duration_ms: number
    output_tail: string
  }>
  overall: "pass" | "fail" | "skip"
  duration_ms: number
}

const DEFAULT_CONFIG: GateConfig = {
  consecutiveRun: 8,
  ngramRepeat: 4,
  sentenceMin: 2,
  unverifiedClaim: 2,
}

/**
 * Streaming gate that watches the model's output token-by-token and can cut a
 * run that is looping (repeated n-grams / long character runs) or making
 * unverified claims.
 *
 * Tries to spawn an optional Python daemon (`streaming_gate.py --daemon`) for
 * richer analysis. If that script is missing or fails to start, the gate
 * degrades to a built-in JS checker so the runtime never breaks and no noisy
 * stderr is printed.
 */
export class StreamingGate {
  private proc: child.ChildProcess | null = null
  private rl: readline.Interface | null = null
  private pending = new Map<number, (msg: Record<string, unknown>) => void>()
  private nextId = 1
  private alive = false
  private useDaemon = false
  private cwd: string
  private scriptPath: string
  private cfg: GateConfig = DEFAULT_CONFIG
  private enabled = true

  // Built-in JS fallback state
  private buffer = ""
  private lastChunks: string[] = []
  private sentenceCount = 0

  constructor(rootDir: string, scriptPath?: string) {
    this.cwd = rootDir
    this.scriptPath = scriptPath ?? path.join(rootDir, "skt", "12-control", "streaming_gate.py")
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  async start(config: Partial<GateConfig> = {}): Promise<boolean> {
    if (this.alive) return true
    this.cfg = { ...DEFAULT_CONFIG, ...config }

    // Built-in JS fallback — instant, no external process. Daemon is an
    // optional background optimization; it may upgrade the checker later.
    this.buffer = ""
    this.lastChunks = []
    this.sentenceCount = 0
    this.alive = true
    this.useDaemon = false

    if (fs.existsSync(this.scriptPath)) {
      this.tryStartDaemon().catch(() => {
        /* daemon is optional */
      })
    }

    return true
  }

  private async tryStartDaemon(): Promise<void> {
    try {
      this.proc = child.spawn("python", ["-u", this.scriptPath, "--daemon"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      this.proc.on("error", () => {
        this.useDaemon = false
        this.proc = null
      })
      this.proc.stderr?.on("data", () => {
        /* swallow daemon stderr — never spam the user's terminal */
      })
      this.rl = readline.createInterface({ input: this.proc.stdout! })
      this.rl.on("line", (line: string) => {
        if (!line.trim()) return
        try {
          const msg = JSON.parse(line) as Record<string, unknown> & { op?: string }
          const id = (msg as { _id?: number })._id
          if (typeof id === "number") {
            const cb = this.pending.get(id)
            if (cb) {
              this.pending.delete(id)
              cb(msg)
            }
          }
        } catch {
          /* ignore malformed daemon output */
        }
      })
      this.proc.on("exit", () => {
        this.useDaemon = false
        this.proc = null
      })
      const ok = await this.request({ op: "init", ...this.cfg })
      if (ok != null && ok.ok === true) {
        this.useDaemon = true
      } else {
        this.useDaemon = false
        try {
          this.proc?.kill()
        } catch {
          /* ignore */
        }
        this.proc = null
      }
    } catch {
      this.useDaemon = false
      this.proc = null
    }
  }

  async ingest(delta: string): Promise<GateDecision | null> {
    if (!this.alive || !this.enabled) return null
    if (this.useDaemon) return this.ingestDaemon(delta)
    return this.ingestJs(delta)
  }

  async finalize(): Promise<GateDecision | null> {
    if (!this.alive) return null
    if (this.useDaemon) {
      const res = await this.request({ op: "finalize" })
      if (!res) return null
      return (res.decision as GateDecision | undefined) ?? null
    }
    return null
  }

  async verify(cwd: string, skipTests = false): Promise<VerifyReport | null> {
    if (!this.alive) return null
    if (this.useDaemon) {
      const res = await this.request({ op: "verify", cwd, skip_tests: skipTests })
      return (res?.report as VerifyReport | undefined) ?? null
    }
    return this.verifyJs(cwd, skipTests)
  }

  async stop(): Promise<void> {
    if (!this.alive) return
    if (this.useDaemon) {
      try {
        await this.request({ op: "quit" })
      } catch {
        /* ignore */
      }
      try {
        this.proc?.kill()
      } catch {
        /* ignore */
      }
    }
    this.alive = false
    this.useDaemon = false
  }

  private ingestDaemon(delta: string): Promise<GateDecision | null> {
    return this.request({ op: "ingest", delta }).then((res) => {
      if (!res) return null
      const decision = res.decision as GateDecision | undefined
      if (!decision || decision.decision === "continue") return null
      return decision
    })
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.alive || !this.useDaemon || !this.proc?.stdin) return Promise.resolve(null)
    const id = this.nextId++
    const tagged = { ...payload, _id: id }
    return new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, 5000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      try {
        this.proc!.stdin!.write(JSON.stringify(tagged) + "\n")
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  private ingestJs(delta: string): GateDecision | null {
    this.buffer += delta
    const runMatch = this.buffer.match(/(.)\1{5,}/)
    if (runMatch) {
      return {
        decision: "cut",
        reason: `character run detected ('${runMatch[0].slice(0, 6)}...')`,
        level: "warn",
        cutAtChar: runMatch.index ?? 0,
        charPos: this.buffer.length,
        totalChars: this.buffer.length,
        details: { type: "char_run" },
      }
    }
    this.lastChunks.push(delta)
    if (this.lastChunks.length > 8) this.lastChunks.shift()
    if (this.lastChunks.length >= 2 && this.lastChunks.every((c) => c === this.lastChunks[0] && c.length > 0)) {
      return {
        decision: "cut",
        reason: "repeated identical chunks (loop detected)",
        level: "warn",
        cutAtChar: 0,
        charPos: this.buffer.length,
        totalChars: this.buffer.length,
        details: { type: "repeat_loop" },
      }
    }
    const digitRun = this.buffer.match(/(\d)\1{4,}/)
    if (digitRun) {
      return {
        decision: "cut",
        reason: `numeric run detected ('${digitRun[0].slice(0, 6)}...')`,
        level: "warn",
        cutAtChar: digitRun.index ?? 0,
        charPos: this.buffer.length,
        totalChars: this.buffer.length,
        details: { type: "digit_run" },
      }
    }
    if (this.buffer.length > 12000) {
      return {
        decision: "cut",
        reason: "output too long",
        level: "warn",
        cutAtChar: 0,
        charPos: this.buffer.length,
        totalChars: this.buffer.length,
        details: { type: "max_length" },
      }
    }
    const words = this.buffer.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length >= 6) {
      const tail = words.slice(-6)
      const first = tail[0]
      if (first && tail.every((w) => w === first)) {
        return {
          decision: "cut",
          reason: `word repetition detected ('${first}' x6)`,
          level: "warn",
          cutAtChar: this.buffer.length - tail.join(" ").length,
          charPos: this.buffer.length,
          totalChars: this.buffer.length,
          details: { type: "word_repeat" },
        }
      }
    }
    if (words.length >= 20) {
      const phrases: string[] = []
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i < words.length - n; i++) {
          phrases.push(words.slice(i, i + n).join(" "))
        }
      }
      const counts = new Map<string, number>()
      for (const p of phrases) counts.set(p, (counts.get(p) ?? 0) + 1)
      for (const [phrase, count] of counts) {
        if (count >= 4 && phrase.trim().length > 4) {
          const idx = this.buffer.toLowerCase().indexOf(phrase)
          return {
            decision: "cut",
            reason: `phrase repetition detected (${count}x '${phrase.slice(0, 32)}...')`,
            level: "warn",
            cutAtChar: idx >= 0 ? idx : 0,
            charPos: this.buffer.length,
            totalChars: this.buffer.length,
            details: { type: "phrase_repeat", phrase, count },
          }
        }
      }
    }
    const sentences = delta.match(/[.!?]+/g)
    if (sentences) this.sentenceCount += sentences.length
    return null
  }

  private verifyJs(cwd: string, skipTests: boolean): VerifyReport {
    const steps: VerifyReport["steps"] = []
    const t0 = Date.now()
    const tsconfig = path.join(cwd, "tsconfig.json")
    if (fs.existsSync(tsconfig)) {
      const t1 = Date.now()
      try {
        child.execSync("npx tsc --noEmit -p tsconfig.json", { cwd, stdio: "pipe", timeout: 60_000 })
        steps.push({
          name: "typecheck",
          command: "tsc --noEmit",
          status: "pass",
          duration_ms: Date.now() - t1,
          output_tail: "",
        })
      } catch (err) {
        const out = (err as child.ExecException).stderr?.toString() ?? (err as Error).message
        steps.push({
          name: "typecheck",
          command: "tsc --noEmit",
          status: "fail",
          duration_ms: Date.now() - t1,
          output_tail: out.slice(-200),
        })
      }
    } else {
      steps.push({
        name: "typecheck",
        command: "tsc --noEmit",
        status: "skip",
        duration_ms: 0,
        output_tail: "no tsconfig.json",
      })
    }
    if (!skipTests) {
      const pkg = path.join(cwd, "package.json")
      if (fs.existsSync(pkg)) {
        try {
          const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }
          if (json.scripts?.test) {
            const t1 = Date.now()
            try {
              child.execSync("npm test", { cwd, stdio: "pipe", timeout: 120_000 })
              steps.push({
                name: "test",
                command: "npm test",
                status: "pass",
                duration_ms: Date.now() - t1,
                output_tail: "",
              })
            } catch (err) {
              const out = (err as child.ExecException).stderr?.toString() ?? (err as Error).message
              steps.push({
                name: "test",
                command: "npm test",
                status: "fail",
                duration_ms: Date.now() - t1,
                output_tail: out.slice(-200),
              })
            }
          } else {
            steps.push({
              name: "test",
              command: "npm test",
              status: "skip",
              duration_ms: 0,
              output_tail: "no test script",
            })
          }
        } catch {
          steps.push({
            name: "test",
            command: "npm test",
            status: "skip",
            duration_ms: 0,
            output_tail: "could not read package.json",
          })
        }
      }
    } else {
      steps.push({ name: "test", command: "npm test", status: "skip", duration_ms: 0, output_tail: "skipped" })
    }
    const failed = steps.filter((s) => s.status === "fail" || s.status === "error")
    return { steps, overall: failed.length > 0 ? "fail" : "pass", duration_ms: Date.now() - t0 }
  }
}

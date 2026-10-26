import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { isRemoteUncPath } from "../../../runtime/src/config.js"

export interface SessionInfo {
  readonly id: string
  readonly name: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly status: "active" | "paused" | "completed" | "error"
  readonly agent?: string
}

export interface SessionManagerInterface {
  readonly create: (name: string) => SessionInfo
  readonly get: (id: string) => SessionInfo | undefined
  readonly list: () => SessionInfo[]
  readonly update: (id: string, updates: Partial<SessionInfo>) => SessionInfo | undefined
  readonly delete: (id: string) => boolean
  readonly fork: (parentId: string, name: string) => SessionInfo | undefined
}

function newSessionId(): string {
  try {
    return `session-${crypto.randomUUID()}`
  } catch {
    return `session-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
  }
}

function sessionsFilePath(): string {
  const explicit = process.env.NEMO_SESSIONS_FILE
  if (explicit) {
    if (isRemoteUncPath(explicit)) {
      // Fail closed without touching the path: existsSync on a UNC target
      // would authenticate to the remote host (NTLM hash leak).
      try {
        process.stderr.write(
          `nemo: refusing remote UNC sessions file "${explicit}" (NTLM/SMB risk) — using default instead.\n`,
        )
      } catch {
        /* stderr unavailable */
      }
    } else return explicit
  }
  return path.join(os.homedir(), ".nemo", "sessions.json")
}

type StoredSession = Omit<SessionInfo, "createdAt" | "updatedAt"> & {
  createdAt: string
  updatedAt: string
}

function revive(s: StoredSession): SessionInfo {
  return { ...s, createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt) }
}

function serialize(s: SessionInfo): StoredSession {
  return {
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

export class SessionManager implements SessionManagerInterface {
  private sessions: Map<string, SessionInfo> = new Map()
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? sessionsFilePath()
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        sessions?: StoredSession[]
      }
      if (!raw || !Array.isArray(raw.sessions)) return
      for (const s of raw.sessions.slice(0, 500)) {
        if (!s || typeof s.id !== "string" || typeof s.name !== "string") continue
        try {
          this.sessions.set(s.id, revive(s))
        } catch {
          /* skip corrupt entry */
        }
      }
    } catch {
      /* corrupt file: start empty, preserve bytes for forensics */
      try {
        if (fs.existsSync(this.file)) {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        }
      } catch {
        /* best effort */
      }
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ sessions: Array.from(this.sessions.values()).map(serialize) }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      })
      try {
        fs.chmodSync(tmp, 0o600)
      } catch {
        /* not all platforms support chmod */
      }
      fs.renameSync(tmp, this.file)
      try {
        fs.chmodSync(this.file, 0o600)
      } catch {
        /* best effort */
      }
    } catch {
      /* persistence must never break the CLI */
    }
  }

  create(name: string): SessionInfo {
    const session: SessionInfo = {
      id: newSessionId(),
      name,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active",
    }
    this.sessions.set(session.id, session)
    this.persist()
    return session
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  update(id: string, updates: Partial<SessionInfo>): SessionInfo | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined

    const updated: SessionInfo = {
      ...session,
      ...updates,
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: new Date(),
    }
    this.sessions.set(id, updated)
    this.persist()
    return updated
  }

  delete(id: string): boolean {
    const ok = this.sessions.delete(id)
    if (ok) this.persist()
    return ok
  }

  fork(parentId: string, name: string): SessionInfo | undefined {
    const parent = this.sessions.get(parentId)
    if (!parent) return undefined

    const child: SessionInfo = {
      id: newSessionId(),
      name: name && name.trim().length > 0 ? name : `${parent.name} (fork)`,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active",
      agent: parent.agent,
    }
    this.sessions.set(child.id, child)
    this.persist()
    return child
  }
}

export const sessionManager = new SessionManager()

/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"

export interface Snapshot {
  id: string
  filePaths: string[]
  contents: Map<string, string | null>
  timestamp: string
  label: string
}

export class RollbackController {
  private snapshots: Map<string, Snapshot> = new Map()
  private readonly snapshotDir: string
  private readonly basePath: string

  constructor(basePath?: string) {
    this.basePath = basePath ?? process.cwd()
    this.snapshotDir = path.join(this.basePath, ".trayambak", "snapshots")
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true })
    }
  }

  captureSnapshot(filePaths: string[], label: string): string {
    const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const contents = new Map<string, string | null>()

    for (const fp of filePaths) {
      const absolutePath = this.toAbsolute(fp)
      try {
        if (fs.existsSync(absolutePath)) {
          contents.set(absolutePath, fs.readFileSync(absolutePath, "utf8"))
        } else {
          contents.set(absolutePath, null)
        }
      } catch {
        contents.set(absolutePath, null)
      }
    }

    const timestamp = new Date().toISOString()
    const snapshot: Snapshot = {
      id,
      filePaths,
      contents,
      timestamp,
      label,
    }

    const snapshotPath = path.join(this.snapshotDir, `${id}.json`)
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        id,
        filePaths,
        contents: Array.from(contents.entries()),
        timestamp,
        label,
      }),
      "utf8",
    )

    this.snapshots.set(id, snapshot)
    return id
  }

  restoreSnapshot(snapshotId: string): boolean {
    const snapshot = this.snapshots.get(snapshotId)
    if (!snapshot) {
      const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`)
      if (!fs.existsSync(snapshotPath)) return false
      const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
      const snap: Snapshot = {
        id: data.id,
        filePaths: data.filePaths,
        contents: new Map(data.contents),
        timestamp: data.timestamp,
        label: data.label,
      }
      this.snapshots.set(snapshotId, snap)
      return this.applySnapshot(snap)
    }
    return this.applySnapshot(snapshot)
  }

  private applySnapshot(snapshot: Snapshot): boolean {
    try {
      for (const [filePath, content] of snapshot.contents.entries()) {
        const absolutePath = this.toAbsolute(filePath)
        if (content === null) {
          if (fs.existsSync(absolutePath)) {
            fs.rmSync(absolutePath, { force: true })
          }
        } else {
          const dir = path.dirname(absolutePath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          fs.writeFileSync(absolutePath, content, "utf8")
        }
      }
      return true
    } catch {
      return false
    }
  }

  private toAbsolute(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath
    return path.resolve(this.basePath, filePath)
  }

  cleanup(): void {
    if (!fs.existsSync(this.snapshotDir)) return
    const entries = fs.readdirSync(this.snapshotDir)
    for (const entry of entries) {
      if (entry.endsWith("on")) {
        try {
          fs.unlinkSync(path.join(this.snapshotDir, entry))
        } catch {
          /* ignore */
        }
      }
    }
  }
}

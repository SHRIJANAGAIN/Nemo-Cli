/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface Artifact {
  id: string
  filename: string
  content: string
  language: string
  version: number
  createdAt: number
  updatedAt: number
  size: number
  metadata?: Record<string, string>
}

export interface ArtifactManifest {
  artifacts: Map<string, Artifact>
  currentId: number
}

export class ArtifactManager {
  private readonly artifactsDir: string
  private readonly manifestFile: string
  private manifest: ArtifactManifest

  constructor(cwd: string) {
    this.artifactsDir = path.join(cwd, "nemo", "10-upload", "artifacts")
    fs.mkdirSync(this.artifactsDir, { recursive: true })
    this.manifestFile = path.join(this.artifactsDir, "manifest.json")
    this.manifest = { artifacts: new Map(), currentId: 1 }
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.manifestFile)) return
      const raw = JSON.parse(fs.readFileSync(this.manifestFile, "utf8")) as Record<string, unknown>
      const artifacts = raw.artifacts as Record<string, Artifact> | undefined
      if (!artifacts) return
      for (const [id, art] of Object.entries(artifacts)) {
        this.manifest.artifacts.set(id, art as Artifact)
      }
      this.manifest.currentId = Math.max(1, ...Array.from(this.manifest.artifacts.keys()).map(Number)) + 1
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    try {
      const obj: Record<string, unknown> = {
        artifacts: Object.fromEntries(this.manifest.artifacts),
        currentId: this.manifest.currentId,
      }
      fs.writeFileSync(this.manifestFile, JSON.stringify(obj, null, 2))
    } catch {
      /* ignore */
    }
  }

  create(filename: string, content: string, language = "text", metadata?: Record<string, string>): Artifact {
    const id = String(this.manifest.currentId++)
    const now = Date.now()
    const artifact: Artifact = {
      id,
      filename,
      content,
      language,
      version: 1,
      createdAt: now,
      updatedAt: now,
      size: Buffer.byteLength(content, "utf8"),
      metadata,
    }
    this.manifest.artifacts.set(id, artifact)
    this.persist()
    this.writeFile(artifact)
    return artifact
  }

  update(id: string, content: string, metadata?: Record<string, string>): Artifact | null {
    const existing = this.manifest.artifacts.get(id)
    if (!existing) return null
    const updated: Artifact = {
      ...existing,
      content,
      version: existing.version + 1,
      updatedAt: Date.now(),
      size: Buffer.byteLength(content, "utf8"),
      metadata: metadata ?? existing.metadata,
    }
    this.manifest.artifacts.set(id, updated)
    this.persist()
    this.writeFile(updated)
    return updated
  }

  get(id: string): Artifact | undefined {
    return this.manifest.artifacts.get(id)
  }

  list(): Artifact[] {
    return Array.from(this.manifest.artifacts.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  delete(id: string): boolean {
    const deleted = this.manifest.artifacts.delete(id)
    if (deleted) {
      this.persist()
      try {
        fs.unlinkSync(this.filePath(id))
      } catch {
        /* ignore */
      }
    }
    return deleted
  }

  search(query: string): Artifact[] {
    const lower = query.toLowerCase()
    return this.list().filter(
      (a) =>
        a.filename.toLowerCase().includes(lower) ||
        a.content.toLowerCase().includes(lower) ||
        (a.metadata?.title ?? "").toLowerCase().includes(lower),
    )
  }

  getByFilename(filename: string): Artifact | undefined {
    return this.list().find((a) => a.filename === filename)
  }

  filePath(id: string): string {
    return path.join(this.artifactsDir, `${id}.json`)
  }

  writeFile(artifact: Artifact): void {
    const file = this.filePath(artifact.id)
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2))
  }

  readFile(id: string): Artifact | null {
    const file = this.filePath(id)
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Artifact
      return raw
    } catch {
      return null
    }
  }

  getArtifactsDir(): string {
    return this.artifactsDir
  }

  getManifestFile(): string {
    return this.manifestFile
  }
}

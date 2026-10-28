/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { createViewImageTool, sniffImageMime, supportedImageExtensions } from "./view-image.js"
import { toolResultImages } from "../../../../../packages/protocol/src/index.js"
import type { ToolContext } from "../types.js"

/**
 * `view_image` is the only producer of `ToolResult.images`, so what matters
 * here is not "does it read a png" but "can it ever send the model something
 * mislabelled or oversized". A wrong `mime` is invisible locally and surfaces
 * as an opaque 400 from a remote endpoint; a silently truncated image produces
 * a confident, wrong description.
 */

const dirs: string[] = []

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewimg-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function ctxFor(cwd: string): ToolContext {
  return { cwd, config: {}, permissions: {} } as unknown as ToolContext
}

/** Minimal real file headers — the sniffer only reads the leading bytes. */
const HEADERS: Record<string, Buffer> = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  "image/gif": Buffer.from("GIF89a\0\0", "latin1"),
  "image/webp": Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBP", "latin1"),
    Buffer.from([0]),
  ]),
}

function writeImage(dir: string, name: string, mime: keyof typeof HEADERS, padding = 32): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.concat([HEADERS[mime], Buffer.alloc(padding, 0x41)]))
  return file
}

async function view(cwd: string, args: Record<string, unknown>) {
  return createViewImageTool().execute("t1", args, undefined, undefined, ctxFor(cwd))
}

function textOf(res: Awaited<ReturnType<typeof view>>): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
}

describe("sniffImageMime", () => {
  it("identifies every supported format from its magic bytes", () => {
    for (const [mime, header] of Object.entries(HEADERS)) {
      expect(sniffImageMime(header)).toBe(mime)
    }
  })

  it("returns undefined for bytes that are not a supported image", () => {
    expect(sniffImageMime(Buffer.from("<svg xmlns=..."))).toBeUndefined()
    expect(sniffImageMime(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBeUndefined() // BMP
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined()
  })

  it("does not trust the extension — a PNG named .jpg is still a PNG", () => {
    const dir = scratch()
    const file = writeImage(dir, "screenshot.jpg", "image/png")
    const buf = fs.readFileSync(file)
    expect(sniffImageMime(buf)).toBe("image/png")
  })

  it("rejects a truncated header rather than guessing", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeUndefined()
  })

  it("lists the extensions it claims to support", () => {
    expect(supportedImageExtensions().sort()).toEqual(["gif", "jpeg", "jpg", "png", "webp"])
  })
})

describe("view_image", () => {
  it("declares a timeout so the harness can bound it", () => {
    expect(createViewImageTool().definition.timeoutMs).toBeGreaterThan(0)
  })

  it("returns the image as a data URL plus a prose caption", async () => {
    const dir = scratch()
    const file = writeImage(dir, "shot.png", "image/png")
    const res = await view(dir, { path: file })

    expect(res.isError).toBe(false)
    const images = toolResultImages(res)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatch(/^data:image\/png;base64,/)
    // The decoded payload must be the file's actual bytes, not a placeholder.
    const encoded = images[0]!.split(",")[1]!
    expect(Buffer.from(encoded, "base64").equals(fs.readFileSync(file))).toBe(true)
    // Prose always present: a text-only backend drops the picture but keeps this.
    expect(textOf(res)).toContain("shot.png")
    expect(textOf(res)).toContain("image/png")
  })

  it("labels each format by its bytes, not its filename", async () => {
    const dir = scratch()
    const file = writeImage(dir, "photo.jpeg", "image/jpeg")
    const res = await view(dir, { path: file })
    expect(toolResultImages(res)[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(textOf(res)).toContain("image/jpeg")
  })

  it("refuses a non-image file by name instead of shipping garbage", async () => {
    const dir = scratch()
    const file = path.join(dir, "diagram.svg")
    fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const res = await view(dir, { path: file })

    expect(res.isError).toBe(true)
    expect(toolResultImages(res)).toHaveLength(0)
    expect(textOf(res)).toContain("Not a supported image")
    expect(textOf(res)).toContain("svg")
  })

  it("reports the real size of an oversized image rather than truncating it", async () => {
    const dir = scratch()
    const file = writeImage(dir, "huge.png", "image/png", 9 * 1024 * 1024)
    const res = await view(dir, { path: file })

    expect(res.isError).toBe(true)
    expect(toolResultImages(res)).toHaveLength(0)
    expect(textOf(res)).toContain("too large")
  })

  it("handles an empty file without throwing", async () => {
    const dir = scratch()
    const file = path.join(dir, "empty.png")
    fs.writeFileSync(file, "")
    const res = await view(dir, { path: file })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("empty")
  })

  it("errors on a missing path argument and on a missing file", async () => {
    const dir = scratch()
    expect((await view(dir, {})).isError).toBe(true)
    const missing = await view(dir, { path: path.join(dir, "nope.png") })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain("No such file")
  })

  it("errors on a directory instead of trying to read one", async () => {
    const dir = scratch()
    const res = await view(dir, { path: dir })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("Not a file")
  })

  it("routes through the shared containment gate, so credential stores stay closed", async () => {
    // `~` is reachable by design, so the read-side deny list is what stops
    // `view_image("~/.ssh/id_rsa.png")` from shipping a private key to a model
    // as a data URL. The gate runs before any stat/open, so no fixture file is
    // needed — and an allow-listed-but-protected path must be denied, not
    // merely "not found".
    const dir = scratch()
    const res = await view(dir, { path: path.join(os.homedir(), ".ssh", "id_rsa.png") })

    expect(res.isError).toBe(true)
    expect(toolResultImages(res)).toHaveLength(0)
    expect(textOf(res)).toMatch(/Access denied/)
  })

  it("denies a credential path before touching the filesystem", async () => {
    // Ordering guarantee: a protected path must not be distinguishable from a
    // missing one by error text, which would leak whether the file exists.
    const dir = scratch()
    const res = await view(dir, { path: path.join(os.homedir(), ".aws", "credentials") })
    expect(textOf(res)).toMatch(/Access denied/)
  })

  it("resolves a relative path against the project root", async () => {
    const dir = scratch()
    writeImage(dir, "rel.png", "image/png")
    const res = await view(dir, { path: "rel.png" })
    expect(res.isError).toBe(false)
    expect(toolResultImages(res)).toHaveLength(1)
  })

  it("returns immediately when the signal is already aborted", async () => {
    const dir = scratch()
    const file = writeImage(dir, "shot.png", "image/png")
    const controller = new AbortController()
    controller.abort()
    const res = await createViewImageTool().execute("t1", { path: file }, controller.signal, undefined, ctxFor(dir))
    expect(res.isError).toBe(true)
    expect(toolResultImages(res)).toHaveLength(0)
  })
})

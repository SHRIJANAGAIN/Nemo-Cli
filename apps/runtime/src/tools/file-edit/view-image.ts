/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath } from "../types.js"

/**
 * Ceiling on an inline image. Base64 inflates by 4/3, so this is ~10.7 MB of
 * encoded payload — past the point where a vision model gains anything from
 * more pixels, and comfortably inside what a chat-completions body will
 * accept. Bigger files are refused with the real size rather than silently
 * truncated: a half-decoded screenshot is worse than an error, because the
 * model will confidently describe the top-left corner.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Bytes that identify each format. Magic-byte sniffing, not the extension:
 * `.png` on a JPEG is common in the wild and every backend trusts the bytes,
 * so labelling by extension sends a PNG header under `image/jpeg` and the
 * endpoint 400s with no useful diagnostic.
 */
const SIGNATURES: ReadonlyArray<{ mime: string; ext: readonly string[]; test: (b: Buffer) => boolean }> = [
  {
    mime: "image/png",
    ext: ["png"],
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/jpeg",
    ext: ["jpg", "jpeg"],
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: ["gif"],
    test: (b) => b.length > 6 && b.subarray(0, 6).toString("latin1").startsWith("GIF8"),
  },
  {
    mime: "image/webp",
    ext: ["webp"],
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
]

/**
 * Identify an image from its leading bytes.
 *
 * Exported for tests: the whole point is that a wrong answer here is
 * invisible until a remote endpoint rejects the request, so the sniffing
 * table is pinned directly rather than only through a rendered result.
 */
export function sniffImageMime(header: Buffer): string | undefined {
  for (const sig of SIGNATURES) {
    if (sig.test(header)) return sig.mime
  }
  return undefined
}

/** Formats we accept. Anything else (SVG, BMP, TIFF, HEIC) is refused by name. */
export function supportedImageExtensions(): string[] {
  return SIGNATURES.flatMap((s) => [...s.ext])
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "view_image",
  description:
    "Look at an image file in the project (png, jpg, gif, webp) and return it to the model so it can be described, debugged, or compared. Use this for screenshots, diagrams, and photos — read_file cannot decode binary data. Max 8 MB.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Relative or absolute path to the image." },
    },
  },
}

export function createViewImageTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      if (signal?.aborted) return textResult("aborted", /*isError*/ true)
      try {
        const ctx = context as ToolContext
        const rawPath = String(args.path ?? "")
        if (!rawPath) return textResult("Missing 'path'.", /*isError*/ true)

        // Same containment gate as every other file tool: the model must not
        // be able to read outside the project (or `~`) just by asking nicely.
        let target: string
        try {
          target = resolveConstrainedPath(rawPath, ctx.cwd)
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), /*isError*/ true)
        }

        if (!fs.existsSync(target)) return textResult(`No such file: ${target}`, /*isError*/ true)
        const stat = fs.statSync(target)
        if (!stat.isFile()) return textResult(`Not a file: ${target}`, /*isError*/ true)
        if (stat.size === 0) return textResult(`File is empty: ${target}`, /*isError*/ true)
        if (stat.size > MAX_IMAGE_BYTES) {
          return textResult(
            `Image too large: ${stat.size} bytes (max ${MAX_IMAGE_BYTES}). Resize it first or crop the region you need.`,
            /*isError*/ true,
          )
        }

        const buf = fs.readFileSync(target)
        const mime = sniffImageMime(buf)
        if (!mime) {
          return textResult(
            `Not a supported image: ${target}. Supported: ${supportedImageExtensions().join(", ")}. ` +
              `SVG and vector formats are not supported — rasterize to png first.`,
            /*isError*/ true,
          )
        }

        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
        const kb = (stat.size / 1024).toFixed(1)
        return {
          content: [
            {
              type: "text",
              text: `${path.basename(target)} (${mime}, ${kb} KB) — attached below.`,
            },
          ],
          isError: false,
          // Carried alongside the prose so the model knows WHAT it is looking
          // at even on a text-only backend, which drops the picture and keeps
          // this line.
          images: [dataUrl],
        }
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), /*isError*/ true)
      }
    },
  }
}

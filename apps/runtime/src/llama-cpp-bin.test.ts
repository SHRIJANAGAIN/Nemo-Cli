/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * extractZip (#80) — the zip and destination paths interpolate into the
 * PowerShell `-Command` source. A single quote in either path (the GPU dir
 * derives from `os.homedir()`, so a profile path can carry one) used to
 * close the quoted string early and fail — or, with a crafted path, turn
 * into executable PowerShell. Both test paths carry a quote.
 */
import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { extractZip } from "./llama-cpp-bin.js"

const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

describe("extractZip command construction (#80)", () => {
  it.skipIf(process.platform !== "win32")("extracts when both paths contain a single quote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llama-quote-"))
    try {
      const quoteDir = path.join(root, "it's-dir")
      fs.mkdirSync(quoteDir, { recursive: true })
      const payload = path.join(root, "payload.txt")
      fs.writeFileSync(payload, "zip-payload", "utf8")
      const zip = path.join(quoteDir, "llama.cpp.zip")
      const dest = path.join(quoteDir, "out")
      fs.mkdirSync(dest, { recursive: true })

      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -Force -LiteralPath ${psLiteral(payload)} -DestinationPath ${psLiteral(zip)}`,
        ],
        { timeout: 60_000, windowsHide: true, stdio: "ignore" },
      )

      await extractZip(zip, dest)

      expect(fs.readFileSync(path.join(dest, "payload.txt"), "utf8")).toBe("zip-payload")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

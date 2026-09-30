#!/usr/bin/env node
/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const here = path.dirname(fileURLToPath(import.meta.url))
const corpusPath = path.join(here, "corpus.txt")
const tsPath = path.join(here, "power-prompt.ts")

const START = "// <<<EMBED-CORPUS:START>>>"
const END = "// <<<EMBED-CORPUS:END>>>"

const corpus = fs.readFileSync(corpusPath, "utf8")
const src = fs.readFileSync(tsPath, "utf8")
// Match the target file's line endings (repo is CRLF).
const EOL = src.includes("\r\n") ? "\r\n" : "\n"

const i = src.indexOf(START)
const j = src.indexOf(END)
if (i === -1 || j === -1 || j < i) {
  console.error(`embed-corpus: markers missing in ${tsPath}`)
  process.exit(1)
}

// Chunk into fixed-size pieces so no single source line is enormous.
// JSON.stringify gives a safe double-quoted string literal (backslashes,
// quotes, and newlines all escaped). Slicing by UTF-16 code units and
// re-joining reconstructs the corpus byte-for-byte.
const CHUNK = 2000
const parts = []
for (let k = 0; k < corpus.length; k += CHUNK) {
  parts.push(JSON.stringify(corpus.slice(k, k + CHUNK)))
}

const block =
  START + EOL + "const CORPUS_INLINE: string[] = [" + EOL + "  " + parts.join("," + EOL + "  ") + EOL + "];" + EOL + END

const out = src.slice(0, i) + block + src.slice(j + END.length)
const changed = out !== src
if (changed) fs.writeFileSync(tsPath, out)
console.log(
  `${changed ? "updated" : "up-to-date"}: corpus.txt ${corpus.length} chars -> ${parts.length} chunks embedded`,
)

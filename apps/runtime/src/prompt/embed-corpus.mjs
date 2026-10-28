#!/usr/bin/env node
/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { format, resolveConfig } from "prettier"

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
// Prettier-normalize before writing: the raw block (JSON.stringify quotes,
// trailing semicolon) is not prettier-clean, and a non-clean write makes
// `npm run format:check` fail right after the documented embed workflow.
const prettierConfig = (await resolveConfig(tsPath)) ?? {}
const formatted = await format(out, { ...prettierConfig, filepath: tsPath })
const changed = formatted !== src
if (changed) fs.writeFileSync(tsPath, formatted)
console.log(
  `${changed ? "updated" : "up-to-date"}: corpus.txt ${corpus.length} chars -> ${parts.length} chunks embedded`,
)

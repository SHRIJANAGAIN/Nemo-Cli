/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Load smoke test for the flattened ink build.
 *
 * `fix-esm-imports.js` verifies that every relative specifier in the emitted
 * .js files points at a file that exists on disk. That check passes on a
 * build which still cannot be imported: a file can exist, be the right
 * format on paper, and still throw on load. The concrete case this exists to
 * catch — under `module: NodeNext` the emit format is decided PER FILE by the
 * nearest package.json to the SOURCE, so a .ts outside
 * packages/tui/src/ink-app/ compiled to CommonJS while every file inside
 * ink-app compiled to ESM. The flattened dir is `type: module`, so those CJS
 * files threw "exports is not defined in ES module scope" the moment the REPL
 * imported them — with a green path-existence check and a green build.
 *
 * So: actually import each entry point and confirm its exports are real.
 *
 * Run standalone or via postbuild (which runs it as build step 4). Resolves
 * ROOT from its own location, so cwd does not matter.
 */

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const distDir = path.join(ROOT, "dist", "packages", "tui", "src", "ink-app-esm")

/** Each entry must expose every named export; the names prove the shape. */
const ENTRY_POINTS = [
  { file: "keymap.js", expect: ["Keymap", "setKeymap", "formatEffectiveKeymapMessage"] },
  { file: "keybindings.js", expect: ["DEFAULT_KEYBINDINGS", "GLOBAL_SHORTCUTS"] },
  { file: "approvalKeys.js", expect: ["approvalDecisionFor", "approvalNavigationFor"] },
  // The module the REPL actually boots. Heavier (pulls react + ink), so it is
  // the one that proves the flattened layout holds together end to end.
  { file: "App.js", expect: ["default"] },
]

if (!fs.existsSync(distDir)) {
  console.error(`ink ESM smoke test: ${distDir} does not exist — run \`npm run build\` first.`)
  process.exit(1)
}

const failures = []

for (const { file, expect } of ENTRY_POINTS) {
  const full = path.join(distDir, file)
  if (!fs.existsSync(full)) {
    failures.push(`${file}: not present in the flattened output`)
    continue
  }
  let mod
  try {
    mod = await import(pathToFileURL(full).href)
  } catch (err) {
    failures.push(`${file}: threw on import — ${err.code ?? err.name}: ` + String(err.message).split("\n")[0])
    continue
  }
  const missing = expect.filter((name) => !(name in mod))
  if (missing.length > 0) {
    failures.push(`${file}: imported but missing export(s) ${missing.join(", ")}`)
  } else {
    console.log(`  ok   ${file} (${expect.length} export(s) verified)`)
  }
}

if (failures.length > 0) {
  console.error(`\nink ESM smoke test FAILED:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
console.log(`\nink ESM smoke test passed (${ENTRY_POINTS.length} entry points)`)

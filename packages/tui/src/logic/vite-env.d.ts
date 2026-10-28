/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Minimal Vite-style `import.meta.env` typing so base-path.ts typechecks
 * without pulling the whole vite package in (vite/client declares the full
 * set; this tree only ever reads VITE_BASE_PATH). Ambient on purpose:
 * no imports/exports here so the interfaces merge into the global scope.
 */
interface ImportMetaEnv {
  /** Deploy-time base path ("/app", "/", …) baked in by Vite at build. */
  readonly VITE_BASE_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

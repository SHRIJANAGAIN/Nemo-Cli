/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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

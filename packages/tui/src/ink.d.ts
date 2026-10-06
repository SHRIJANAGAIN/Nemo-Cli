// Type declarations for ink module - used by ink-app and repl components.
//
// The ink-app tree resolves `ink` to the real package under node_modules
// (tsconfig.ink.json / NodeNext resolution) and never sees this file; this
// ambient shim only covers the classic `moduleResolution: node` program, so
// the shapes here are deliberately structural (index-signature props) rather
// than a mirror of ink's full prop surface.
declare module "ink" {
  import * as React from "react"

  export interface Instance {
    rerender: (node: React.ReactNode) => void
    unmount: () => void
    waitUntilExit: () => Promise<void>
  }

  /** Key state reported to `useInput` handlers. */
  export interface Key {
    ctrl?: boolean
    shift?: boolean
    meta?: boolean
    return?: boolean
    escape?: boolean
    backspace?: boolean
    delete?: boolean
    // Arrow flags carry ink's real names (`upArrow`, …) — keymap.ts and the
    // ink-app tree both code against those; the classic program must match
    // or `npm run typecheck` diverges from typecheck:ink.
    upArrow?: boolean
    downArrow?: boolean
    leftArrow?: boolean
    rightArrow?: boolean
    tab?: boolean
    space?: boolean
    pageUp?: boolean
    pageDown?: boolean
  }

  export const render: (node: React.ReactNode, options?: Record<string, unknown>) => Instance
  export const Box: React.FC<Record<string, unknown>>
  export const Text: React.FC<Record<string, unknown>>
  export const Spacer: React.FC<Record<string, unknown>>
  export const useInput: (handler: (input: string, key: Key) => void) => void
  export const useStdout: () => { stdout: NodeJS.WriteStream | undefined }
  export const useApp: () => { exit: (error?: Error) => void; isRawModeSupported: boolean }
  export const useEffect: typeof React.useEffect
  export const useState: typeof React.useState
  export const useRef: typeof React.useRef
  export const Fragment: typeof React.Fragment
  export const createElement: typeof React.createElement
  export type ReactNode = React.ReactNode
  export type FC<P = Record<string, unknown>> = React.FC<P>
}

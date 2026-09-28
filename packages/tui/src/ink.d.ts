// Type declarations for ink module - used by ink-app and repl components
declare module "ink" {
  export const render: any
  export const Box: any
  export const Text: any
  export const Spacer: any
  export const useInput: (handler: (input: string, key: any) => void) => void
  export const useStdout: () => any
  export const useApp: () => any
  export const useEffect: any
  export const useState: any
  export const useRef: any
  export const Fragment: any
  export const createElement: any
  export const ReactNode: any
  export const FC: any
}

/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { getTheme, fg, RESET, BOLD, visibleLen, type Rgb, type Theme } from "./theme"

import { SplitBorder } from "./border"
import { renderBox } from "./box"

export type ToastVariant = "info" | "success" | "warning" | "error"

export type ToastOptions = {
  title?: string
  message: string
  variant: ToastVariant
  duration?: number
}

const VARIANT_TOKEN: Record<ToastVariant, keyof Theme> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
}

/** Auto-dismissing toast notifications (top-right, side borders). */
export class ToastManager {
  private current: ToastOptions | null = null
  private timeout: NodeJS.Timeout | null = null

  show(options: ToastOptions): void {
    this.current = { ...options, duration: options.duration ?? 5000 }
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = setTimeout(() => {
      this.current = null
    }, this.current.duration)
    this.timeout.unref?.()
  }

  error(err: unknown): void {
    this.show({
      variant: "error",
      message: err instanceof Error ? err.message : "An unknown error has occurred",
    })
  }

  get active(): ToastOptions | null {
    return this.current
  }

  /** Render the active toast (or empty string when none). */
  render(): string {
    if (!this.current) return ""
    const theme = getTheme()
    const token = VARIANT_TOKEN[this.current.variant]
    const dot = fg(theme[token] as Rgb) + "●" + RESET
    const title = this.current.title ? dot + " " + BOLD + this.current.title + RESET : dot
    const inner = title + "\n" + this.current.message
    return renderBox(inner, {
      border: "split",
      borderColor: token,
      title: undefined,
      paddingX: 2,
      maxWidth: 60,
    })
  }
}

export const toast = new ToastManager()

/** One-line inline notice with variant dot. */
export function noticeLine(message: string, variant: ToastVariant = "info"): string {
  const theme = getTheme()
  const token = VARIANT_TOKEN[variant]
  const dot = fg(theme[token] as Rgb) + "●" + RESET
  return `${dot} ${message}`
}

export { SplitBorder, visibleLen }

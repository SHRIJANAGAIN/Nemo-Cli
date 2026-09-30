/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Port of the Trayambak Code reference `approval_overlay.rs`
 * -- ApprovalChoice type and ApprovalOverlay render with three-choice default.
 */

export type ApprovalChoice = "allow" | "deny" | "allow-always"

export interface ApprovalOption {
  label: string
  choice: ApprovalChoice
}

const DEFAULT_OPTIONS: ApprovalOption[] = [
  { label: "Yes, proceed", choice: "allow" },
  { label: "Yes, and don't ask again", choice: "allow-always" },
  { label: "No, cancel", choice: "deny" },
]

export class ApprovalOverlay {
  private options: ApprovalOption[]
  private selectedIndex: number = 0
  private scrollTop: number = 0

  constructor(options?: ApprovalOption[]) {
    this.options = options || DEFAULT_OPTIONS
  }

  render(
    tool: string,
    args: string[],
    reason: string | undefined,
    area: { width: number; height: number },
    isFocused: boolean,
  ): string[] {
    const lines: string[] = []
    lines.push("\x1b[1;33mTool Approval Required\x1b[0m")
    if (tool) {
      lines.push("  \x1b[1m" + tool + "\x1b[0m " + args.join(" "))
    }
    if (reason) {
      lines.push("  \x1b[2mReason: " + reason + "\x1b[0m")
    }
    lines.push("")

    const visibleCount = Math.min(area.height - 4, this.options.length)
    if (this.selectedIndex < this.scrollTop) {
      this.scrollTop = this.selectedIndex
    } else if (this.selectedIndex >= this.scrollTop + visibleCount) {
      this.scrollTop = this.selectedIndex - visibleCount + 1
    }

    for (let i = this.scrollTop; i < this.scrollTop + visibleCount && i < this.options.length; i++) {
      const opt = this.options[i]
      const selected = isFocused && i === this.selectedIndex
      const prefix = selected ? "> " : "  "
      const marker = selected ? "\x1b[47m\x1b[30m" : "\x1b[2m"
      const reset = selected ? "\x1b[0m" : ""
      lines.push(marker + prefix + opt.label + reset)
    }

    if (isFocused) {
      lines.push("")
      lines.push("\x1b[2mup/down navigate  enter confirm  esc cancel\x1b[0m")
    }

    return lines
  }

  moveUp(): void {
    if (this.options.length === 0) return
    this.selectedIndex = (this.selectedIndex - 1 + this.options.length) % this.options.length
  }

  moveDown(): void {
    if (this.options.length === 0) return
    this.selectedIndex = (this.selectedIndex + 1) % this.options.length
  }

  getSelectedChoice(): ApprovalChoice | undefined {
    return this.options[this.selectedIndex]?.choice
  }

  handleEscape(): boolean {
    this.selectedIndex = this.options.findIndex((o) => o.choice === "deny")
    return true
  }
}

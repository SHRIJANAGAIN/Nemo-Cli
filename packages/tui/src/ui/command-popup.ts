/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Port of the Codex reference `command_popup.rs`
 * -- CommandPopup with filter/match, up/down navigation, and string[] rendering.
 */

export type CommandItem = {
  name: string
  description: string
  hidden?: boolean
}

export class CommandPopup {
  private visibleItems: CommandItem[] = []
  private selectedIndex: number = 0
  private scrollTop: number = 0

  private filterItems(items: CommandItem[], query: string): CommandItem[] {
    if (!query) return items.filter((i) => !i.hidden)
    const q = query.toLowerCase()
    return items
      .filter((i) => {
        if (i.hidden) return false
        return i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
      })
      .map((item) => {
        const lowerName = item.name.toLowerCase()
        const indices: number[] = []
        let searchPos = 0
        for (let qi = 0; qi < q.length;) {
          const idx = lowerName.indexOf(q[qi], searchPos)
          if (idx === -1) break
          indices.push(idx)
          searchPos = idx + 1
          qi++
        }
        return { ...item, _matchIndices: indices }
      })
  }

  private static highlightName(name: string, indices: number[]): string {
    if (!indices.length) return name
    const chars = name.split("")
    const result: string[] = []
    for (let i = 0; i < chars.length; i++) {
      if (indices.includes(i)) {
        result.push("\x1b[1;38;5;33m" + chars[i] + "\x1b[0m")
      } else {
        result.push(chars[i])
      }
    }
    return result.join("")
  }

  render(
    commands: CommandItem[],
    query: string,
    area: { width: number; height: number },
    isFocused: boolean,
  ): string[] {
    this.visibleItems = this.filterItems(commands, query)

    const filteredItems = this.visibleItems
    if (this.selectedIndex >= filteredItems.length) {
      this.selectedIndex = Math.max(0, filteredItems.length - 1)
    }
    if (filteredItems.length > 0 && this.selectedIndex < 0) {
      this.selectedIndex = 0
    }

    const maxHeight = area.height
    const visibleCount = Math.min(maxHeight, filteredItems.length)

    if (this.selectedIndex < this.scrollTop) {
      this.scrollTop = this.selectedIndex
    } else if (this.selectedIndex >= this.scrollTop + visibleCount) {
      this.scrollTop = this.selectedIndex - visibleCount + 1
    }

    const lines: string[] = []
    if (filteredItems.length === 0) {
      lines.push("\x1b[2mNo matches\x1b[0m")
      return lines
    }

    for (let i = this.scrollTop; i < this.scrollTop + visibleCount && i < filteredItems.length; i++) {
      const item = filteredItems[i]
      const selected = isFocused && i === this.selectedIndex
      const prefix = selected ? "> " : "  "
      const matchIndices = (item as CommandItem & { _matchIndices?: number[] })._matchIndices
      // Pad the PLAIN name to the fixed label width, then highlight. padEnd
      // counts UTF-16 units, so highlighting first made the ~15 escape bytes
      // per match eat the padding budget — the label field shrank and the
      // description column slid left only on name-matched rows.
      const padded = item.name.padEnd(24)
      const highlighted = matchIndices?.length ? CommandPopup.highlightName(padded, matchIndices) : padded
      const desc = item.description || ""
      if (selected) {
        lines.push("\x1b[47m\x1b[30m" + prefix + highlighted + "\x1b[0m \x1b[2m" + desc + "\x1b[0m")
      } else {
        lines.push(prefix + highlighted + " \x1b[2m" + desc + "\x1b[0m")
      }
    }

    return lines
  }

  moveUp(): void {
    if (this.visibleItems.length === 0) return
    this.selectedIndex = (this.selectedIndex - 1 + this.visibleItems.length) % this.visibleItems.length
  }

  moveDown(): void {
    if (this.visibleItems.length === 0) return
    this.selectedIndex = (this.selectedIndex + 1) % this.visibleItems.length
  }

  getSelectedIndex(): number {
    return this.selectedIndex
  }

  getSelectedItem(): CommandItem | undefined {
    return this.visibleItems[this.selectedIndex]
  }
}

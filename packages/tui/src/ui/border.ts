/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Border styles for boxes and dialogs. */
export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

/** Vertical-only side borders (used by toasts). */
export const SplitBorder = {
  sides: ["left", "right"] as const,
  chars: { ...EmptyBorder, vertical: "┃" },
}

export const RoundedBorder = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  vertical: "│",
  horizontal: "─",
  leftT: "├",
  rightT: "┤",
  topT: "┬",
  bottomT: "┴",
  cross: "┼",
}

export const SharpBorder = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  vertical: "│",
  horizontal: "─",
  leftT: "├",
  rightT: "┤",
  topT: "┬",
  bottomT: "┴",
  cross: "┼",
}

export const DoubleBorder = {
  topLeft: "╔",
  topRight: "╗",
  bottomLeft: "╚",
  bottomRight: "╝",
  vertical: "║",
  horizontal: "═",
  leftT: "╠",
  rightT: "╣",
  topT: "╦",
  bottomT: "╩",
  cross: "╬",
}

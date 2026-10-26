/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Text } from "ink"
import { useCountUp } from "./use-animation-clock.js"

export interface CountUpProps {
  value: number
  /** Decimals to show (default 0). */
  precision?: number
  durationMs?: number
  color?: string
  dimColor?: boolean
  bold?: boolean
  /** Thousands separators, on by default: `128400 tokens` is a number the eye
   *  has to parse, `128,400` is not. */
  grouped?: boolean
}

/** A number that eases to its new value instead of snapping. */
export function CountUp({
  value,
  precision = 0,
  durationMs,
  color,
  dimColor = false,
  bold = false,
  grouped = true,
}: CountUpProps): ReactNode {
  const shown = useCountUp(value, { precision, durationMs })
  const text = grouped
    ? shown.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })
    : shown.toFixed(precision)
  return (
    <Text color={color} dimColor={dimColor} bold={bold}>
      {text}
    </Text>
  )
}

export default CountUp

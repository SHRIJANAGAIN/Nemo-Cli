/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * HTML→text helpers that never use a regex for tag matching: `/<[^>]+>/`
 * style filters can be bypassed (`<scri<p>pt>`) and backtrack badly on hostile
 * input, so tags and skip-regions are scanned character by character instead.
 * The output is plain text for the model, not markup for a browser.
 */

const SKIP_TAGS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "object",
  "embed",
  "form",
  "button",
  "textarea",
  "select",
  "option",
] as const

function skipRegion(lower: string, at: number): number | null {
  if (lower.startsWith("<!--", at)) {
    const end = lower.indexOf("-->", at + 4)
    return end === -1 ? lower.length : end + 3
  }
  for (const tag of SKIP_TAGS) {
    const prefix = `<${tag}`
    if (!lower.startsWith(prefix, at)) continue
    const next = lower[at + prefix.length]
    if (next !== undefined && !/[\s/>]/.test(next)) continue
    const close = lower.indexOf(`</${tag}`, at)
    if (close === -1) return lower.length
    const gt = lower.indexOf(">", close)
    return gt === -1 ? lower.length : gt + 1
  }
  return null
}

/** Drop comments and the contents of script/style/embedded-widget elements. */
export function stripRegions(html: string): string {
  const lower = html.toLowerCase()
  let out = ""
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    const skipTo = skipRegion(lower, lt)
    if (skipTo !== null) {
      out += " "
      i = skipTo
      continue
    }
    out += "<"
    i = lt + 1
  }
  return out
}

/** Remove every tag, keeping its inner text. An unterminated tag ends the scan. */
export function stripTags(html: string): string {
  let out = ""
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf("<", i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    const gt = html.indexOf(">", lt)
    if (gt === -1) break
    out += " "
    i = gt + 1
  }
  return out
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  cent: "\u00a2",
  pound: "\u00a3",
  yen: "\u00a5",
  euro: "\u20ac",
  copy: "\u00a9",
  reg: "\u00ae",
}

const NUMERIC_ENTITIES: Record<number, string> = {
  39: "'",
  96: "`",
  160: " ",
  8211: "-",
  8212: "--",
  8216: "'",
  8217: "'",
  8220: '"',
  8221: '"',
  8230: "...",
}

/** One left-to-right pass, so "&amp;lt;" decodes to "&lt;" and never to "<". */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|([a-z][a-z0-9]{1,31}));/gi, (match, hex, dec, name) => {
    if (name) return NAMED_ENTITIES[(name as string).toLowerCase()] ?? match
    const code = hex ? parseInt(hex as string, 16) : parseInt(dec as string, 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
    return NUMERIC_ENTITIES[code] ?? String.fromCodePoint(code)
  })
}

/** HTML → plain text: skip regions removed, tags stripped, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(stripTags(stripRegions(html)))
}

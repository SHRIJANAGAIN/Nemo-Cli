/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Normalize any http/https URLs in a string so that IDN/Unicode hostnames are
 * converted to their punycode ASCII form, preventing homograph attacks in
 * permission dialogs where visually identical Unicode characters (e.g. Cyrillic
 * 'а' U+0430) could impersonate trusted domains (e.g. 'apitest.com').
 *
 * Example: "curl https://аpitest.com/status" (Cyrillic а)
 *    → "curl https://xn--pitest-2nf.com/status"
 *
 * Trailing sentence punctuation (. , ! ? ; :) that \S+ would otherwise consume
 * into the URL match is stripped before parsing and left in place afterward, so
 * plain-text prose like "see https://example.com." is returned unchanged.
 *
 * Only the hostname is replaced, not the full href, to avoid side-effects such
 * as new URL() appending a trailing slash to bare origins.
 */
export function normalizeUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (match) => {
    const stripped = match.replace(/[.,!?;:)"'\]]+$/, "")
    const tail = match.slice(stripped.length)
    try {
      const parsed = new URL(stripped)
      const afterScheme = stripped.indexOf("//") + 2
      const slashPos = stripped.indexOf("/", afterScheme)
      const rawHost = slashPos === -1 ? stripped.slice(afterScheme) : stripped.slice(afterScheme, slashPos)
      // Drop userinfo (user[:password]@) — only the hostname is compared and
      // replaced. The old code took the whole authority: a no-port userinfo
      // made the comparison fail and silently DELETED the credentials, and a
      // userinfo with a colon split at that colon and spliced the punycode
      // host into the credentials ("https://example.com:secret@example.com").
      const at = rawHost.lastIndexOf("@")
      const hostPart = at === -1 ? rawHost : rawHost.slice(at + 1)
      const colon = hostPart.indexOf(":")
      const rawHostname = colon === -1 ? hostPart : hostPart.slice(0, colon)
      if (!rawHostname || rawHostname === parsed.hostname) return match
      return stripped.replace(rawHostname, parsed.hostname) + tail
    } catch {
      return match
    }
  })
}

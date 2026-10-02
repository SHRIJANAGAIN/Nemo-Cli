/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Network guard for the web tools (#73): link-local / cloud-metadata
 * addresses are never a legitimate fetch target. 169.254.0.0/16 (the
 * 169.254.169.254 instance metadata service), IPv6 link-local fe80::/10,
 * and their IPv4-mapped forms are refused at two layers:
 *
 *   1. `urlBlockReason` — literal-IP hostnames, checked on the initial
 *      URL and again on every redirect hop, before any socket opens.
 *   2. `guardedLookup`  — the address the hostname actually resolves to,
 *      which defeats DNS rebinding (an allowed hostname resolving into
 *      link-local space after the URL itself looked safe).
 *
 * Loopback and private ranges are deliberately NOT blocked: browsing the
 * local dev server is a core use of these tools (web_browse even has an
 * explicit loopback policy for plain HTTP).
 */

import * as dns from "node:dns"

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void

/** IPv4 link-local 169.254.0.0/16 — cloud IMDS lives at 169.254.169.254. */
function isLinkLocalV4(address: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!octets) return false
  return Number(octets[1]) === 169 && Number(octets[2]) === 254
}

/** IPv6 link-local fe80::/10 (first hextet fe80–febf), plus IPv4-mapped
 *  `::ffff:169.254.x.x` written in v6 form. */
function isLinkLocalV6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
  if (mapped) return isLinkLocalV4(mapped[1])
  return /^fe[89ab][0-9a-f]*:/.test(lower)
}

/** True when `address` (a literal IP or a DNS result) is link-local. */
export function isBlockedAddress(address: string): boolean {
  return isLinkLocalV4(address) || isLinkLocalV6(address)
}

/** Why `u` must not be fetched, or null when it is allowed. Re-run on
 *  every redirect hop so a safe-looking first hop can't pivot (#73). */
export function urlBlockReason(u: URL): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `unsupported protocol "${u.protocol}" (only http/https)`
  }
  if (isBlockedAddress(u.hostname)) {
    return `link-local / cloud-metadata address "${u.hostname}" is never fetchable`
  }
  return null
}

/** `dns.lookup` shaped for `RequestOptions.lookup`: refuses resolutions
 *  into link-local space so a hostname can't rebind into the metadata
 *  service after the URL itself looked safe (#73). */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address, family)
      return
    }
    const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address]
    const bad = addresses.find((a) => isBlockedAddress(a))
    if (bad) {
      const blocked: NodeJS.ErrnoException = new Error(`Refusing to resolve ${hostname} to link-local address ${bad}`)
      blocked.code = "EACCES"
      callback(blocked, "", undefined)
      return
    }
    callback(null, address, family)
  })
}

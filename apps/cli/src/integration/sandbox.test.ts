/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { SandboxService } from "./sandbox.js"

/**
 * Policy matrix for the integration-level sandbox gate: three named
 * operations (network/filesystem/mutation), an allow-by-default fallback
 * for unknown operations, and a master switch that bypasses everything.
 */
describe("SandboxService defaults", () => {
  it("starts fully enabled with every operation permitted", () => {
    const service = new SandboxService()
    expect(service.getConfig()).toEqual({ enabled: true, network: true, filesystem: true, mutation: true })
    expect(service.config).toEqual(service.getConfig())
    expect(service.allow("network")).toBe(true)
    expect(service.allow("filesystem")).toBe(true)
    expect(service.allow("mutation")).toBe(true)
    expect(() => service.assert("network")).not.toThrow()
  })

  it("unknown operations are allowed by default", () => {
    const service = new SandboxService()
    expect(service.allow("wormhole")).toBe(true)
    expect(() => service.assert("wormhole")).not.toThrow()
  })
})

describe("SandboxService.setConfig", () => {
  it("disabling one operation leaves the others open", () => {
    const service = new SandboxService()
    service.setConfig({ network: false })
    expect(service.allow("network")).toBe(false)
    expect(service.allow("filesystem")).toBe(true)
    expect(service.allow("mutation")).toBe(true)
  })

  it("merges partially: untouched keys keep their values", () => {
    const service = new SandboxService()
    service.setConfig({ mutation: false })
    expect(service.getConfig()).toEqual({ enabled: true, network: true, filesystem: true, mutation: false })
  })
})

describe("SandboxService.assert", () => {
  it("throws a labelled error for a blocked operation", () => {
    const service = new SandboxService()
    service.setConfig({ filesystem: false })
    expect(() => service.assert("filesystem")).toThrowError("Sandbox blocked: filesystem")
    // Neighbouring operations stay permitted.
    expect(() => service.assert("network")).not.toThrow()
  })

  it("catches every denied operation: network, filesystem and mutation", () => {
    const service = new SandboxService()
    service.setConfig({ enabled: true, network: false, filesystem: false, mutation: false })
    for (const operation of ["network", "filesystem", "mutation"]) {
      expect(() => service.assert(operation), operation).toThrowError(`Sandbox blocked: ${operation}`)
      expect(service.allow(operation), operation).toBe(false)
    }
  })

  it("disabling the sandbox permits operations that would otherwise be denied", () => {
    const service = new SandboxService()
    service.setConfig({ enabled: false, network: false, filesystem: false, mutation: false })
    for (const operation of ["network", "filesystem", "mutation", "anything"]) {
      expect(service.allow(operation), operation).toBe(true)
      expect(() => service.assert(operation), operation).not.toThrow()
    }
  })

  it("re-enabling restores the stored policy", () => {
    const service = new SandboxService()
    service.setConfig({ enabled: false, network: false })
    expect(service.allow("network")).toBe(true)
    service.setConfig({ enabled: true })
    expect(service.allow("network")).toBe(false)
    expect(() => service.assert("network")).toThrowError("Sandbox blocked: network")
  })
})

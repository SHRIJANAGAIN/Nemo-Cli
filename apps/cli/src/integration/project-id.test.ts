/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ProjectIdService } from "./project-id.js"

/**
 * Detection reads marker files from a real directory, so each case gets a
 * fresh temp root that is wiped between tests. Nothing here touches the
 * singleton export — behavior lives on the class.
 */
let tempRoot = ""

const makeProject = (files: string[]): string => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.mkdirSync(tempRoot, { recursive: true })
  for (const file of files) {
    fs.writeFileSync(path.join(tempRoot, file), "{}", "utf8")
  }
  return tempRoot
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-project-id-"))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe("ProjectIdService.detect", () => {
  it("names the project after the final path segment, separators tolerated", () => {
    const service = new ProjectIdService()
    const root = makeProject(["package.json"])
    expect(service.detect(root).name).toBe(path.basename(root))
    expect(service.detect(`${root}${path.sep}`).name).toBe(path.basename(root))
    // POSIX-style separators split too, even on Windows.
    expect(service.detect("C:/repos/my-app").name).toBe("my-app")
  })

  it("stamps a project-<epoch> id and records the root", () => {
    const service = new ProjectIdService()
    const root = makeProject([])
    const info = service.detect(root)
    expect(info.id).toMatch(/^project-\d+$/)
    expect(info.root).toBe(root)
    expect(service.getProject()).toBe(info)
  })

  it("detects the project type by marker-file priority", () => {
    const service = new ProjectIdService()
    // package.json wins over every other marker in the same directory.
    expect(service.detect(makeProject(["package.json", "Cargo.toml"])).type).toBe("node")
    expect(service.detect(makeProject(["tsconfig.json", "go.mod"])).type).toBe("typescript")
    expect(service.detect(makeProject(["Cargo.toml", "go.mod"])).type).toBe("rust")
    expect(service.detect(makeProject(["go.mod", "pyproject.toml"])).type).toBe("go")
    expect(service.detect(makeProject(["pyproject.toml", "pom.xml"])).type).toBe("python")
    expect(service.detect(makeProject(["pom.xml", "build.gradle"])).type).toBe("java")
    expect(service.detect(makeProject(["build.gradle"])).type).toBe("gradle")
  })

  it("maps each project type to its language", () => {
    const service = new ProjectIdService()
    expect(service.detect(makeProject(["package.json"])).language).toBe("javascript")
    expect(service.detect(makeProject(["tsconfig.json"])).language).toBe("typescript")
    expect(service.detect(makeProject(["Cargo.toml"])).language).toBe("rust")
    expect(service.detect(makeProject(["go.mod"])).language).toBe("go")
    expect(service.detect(makeProject(["pyproject.toml"])).language).toBe("python")
    expect(service.detect(makeProject(["pom.xml"])).language).toBe("java")
    expect(service.detect(makeProject(["build.gradle"])).language).toBe("java")
  })

  it("leaves type and language undefined for an unrecognised directory", () => {
    const service = new ProjectIdService()
    const info = service.detect(makeProject(["README.txt"]))
    expect(info.type).toBeUndefined()
    expect(info.language).toBeUndefined()
  })

  it("re-detecting replaces the stored project", () => {
    const service = new ProjectIdService()
    const root = makeProject(["package.json"])
    const first = service.detect(root)
    const second = service.detect("C:/repos/other")
    expect(second.root).toBe("C:/repos/other")
    expect(service.getProject()).toBe(second)
    expect(service.getProject()).not.toBe(first)
  })
})

describe("ProjectIdService.update", () => {
  it("merges partial updates into the detected project", () => {
    const service = new ProjectIdService()
    const root = makeProject(["package.json"])
    const before = service.detect(root)
    service.update({ name: "renamed", language: "typescript" })
    expect(service.getProject()).toEqual({
      ...before,
      name: "renamed",
      language: "typescript",
    })
  })

  it("is a no-op before anything has been detected", () => {
    const service = new ProjectIdService()
    expect(service.getProject()).toBeUndefined()
    expect(() => service.update({ name: "early" })).not.toThrow()
    expect(service.getProject()).toBeUndefined()
  })
})

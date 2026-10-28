/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { failOutput, usageOutput } from "../command-registry.js"

const execFileAsync = promisify(execFile)

export type GhRunner = (args: string[], cwd: string) => Promise<string>

const defaultRunner: GhRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("gh", args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") throw new Error("gh CLI not found — install it from https://cli.github.com")
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function linkFile(cwd: string): string {
  return join(cwd, ".nemo", "pr.json")
}

export interface PrLink {
  url: string
  linkedAt: string
}

/** Read the PR linked to this project, if any. Pure apart from fs. */
export function readPrLink(cwd: string): PrLink | null {
  const file = linkFile(cwd)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PrLink>
    if (typeof parsed.url !== "string" || !parsed.url) return null
    return { url: parsed.url, linkedAt: typeof parsed.linkedAt === "string" ? parsed.linkedAt : "" }
  } catch {
    return null
  }
}

/** `nemo pr checkout <number>`: check out a PR branch via gh. */
export async function prCheckout(number: string, cwd: string, run: GhRunner = defaultRunner): Promise<string> {
  if (!/^\d+$/.test(number.trim())) return failOutput(`Error: PR number must be numeric, got '${number}'`)
  try {
    const out = await run(["pr", "checkout", number.trim()], cwd)
    return out.length > 0 ? out : `Checked out PR #${number.trim()}`
  } catch (error) {
    return failOutput(`Error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `nemo pr link <url>`: attach a PR to this project. */
export function prLink(url: string, cwd: string): string {
  const clean = url.trim()
  if (!clean) return failOutput("Error: PR URL must not be empty")
  mkdirSync(join(cwd, ".nemo"), { recursive: true })
  writeFileSync(linkFile(cwd), JSON.stringify({ url: clean, linkedAt: new Date().toISOString() }, null, 2), "utf8")
  return `Linked ${clean}`
}

/** `nemo pr unlink`: detach the project PR. */
export function prUnlink(cwd: string): string {
  const file = linkFile(cwd)
  if (!existsSync(file)) return "No PR linked"
  rmSync(file, { force: true })
  return "Unlinked PR"
}

/** `nemo pr status`: linked PR (if any) plus `gh pr status`. */
export async function prStatus(cwd: string, run: GhRunner = defaultRunner): Promise<string> {
  const link = readPrLink(cwd)
  const lines = [`Linked PR: ${link ? link.url : "none"}`]
  try {
    const out = link
      ? await run(["pr", "view", link.url, "--json", "state,title"], cwd)
      : await run(["pr", "status"], cwd)
    if (out) lines.push(out)
  } catch (error) {
    lines.push(`gh status failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return lines.join("\n")
}

export type PrAction = "checkout" | "link" | "unlink" | "status"

/** `nemo pr <checkout|link|unlink|status>`: pull-request helpers via gh. */
export async function prCommand(
  action: string,
  arg: string | undefined,
  cwd: string,
  run: GhRunner = defaultRunner,
): Promise<string> {
  const normalized = action.trim().toLowerCase() as PrAction | ""
  switch (normalized) {
    case "checkout":
      if (!arg) return usageOutput("Usage: nemo pr checkout <number>")
      return prCheckout(arg, cwd, run)
    case "link":
      if (!arg) return usageOutput("Usage: nemo pr link <url>")
      return prLink(arg, cwd)
    case "unlink":
      return prUnlink(cwd)
    case "":
    case "status":
      return prStatus(cwd, run)
    default:
      return usageOutput(`Unknown pr action: ${action}. Available: checkout|link|unlink|status`)
  }
}

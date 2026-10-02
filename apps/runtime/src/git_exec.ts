/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { execFile } from "child_process"
import { promisify } from "util"
import { getSafeEnv } from "../../../packages/core/src/env_filter.js"

const execFileP = promisify(execFile)

/** Repo-wide 256KB output cap for git children (AGENTS: process output is
 *  capped at 256KB). */
const GIT_MAX_BUFFER = 256 * 1024
/** Default per-call bound: a credential prompt (URL branch, ssh passphrase)
 *  must not hang the git child past the caller's lifetime. */
const GIT_DEFAULT_TIMEOUT_MS = 30_000

/**
 * Run git with the same child-process boundary every other repo-command
 * path (bash, skills, hook-exec, pentest) already carries:
 *
 * - **Filtered env.** `git worktree add` executes the repository's
 *   `post-checkout` hook (verified) and checkout runs any configured
 *   smudge/clean filters — repository-controlled code. With raw
 *   `process.env` those children inherit every secret, while the same
 *   command typed into `bash` gets `getSafeEnv` (#78). A prompt-injected
 *   model that writes `.git/hooks/*` inside the project and then triggers
 *   a worktree op would otherwise exfiltrate secrets past the env filter.
 * - **Hard timeout.** An interactive prompt would otherwise hang the git
 *   child forever and orphan it once the caller gave up.
 * - **256KB output cap**, matching the repo-wide rule.
 */
export function gitExec(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: getSafeEnv(process.env),
  })
}

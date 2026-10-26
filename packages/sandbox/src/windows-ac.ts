/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Windows AppContainer OS sandbox — the real isolator behind
 * `SandboxType.WindowsRestrictedToken` and backend `"windows-restricted"`.
 *
 * Windows has no built-in CLI sandbox (no seatbelt/bwrap equivalent), so we
 * compose primitives Windows DOES enforce at the kernel level:
 *
 *  - **AppContainer process**: `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_
 *    SECURITY_CAPABILITIES` (0x00020009). The child gets a dedicated profile
 *    SID, a Low integrity label, and no user SID — every file operation is
 *    checked against explicit ACE grants only (default deny). Administrators
 *    land "deny only". No admin rights required.
 *  - **NTFS grants via `icacls`**: writable roots / cwd / scratch get `F`
 *    for the profile SID, `USERPROFILE` gets `R` (reads are policy-allowed
 *    anyway), deny paths get deny ACEs (deny beats allow). Every grant runs
 *    under a per-path deadline with a per-spawn budget and a 24h journal:
 *    a wedged path is killed and skipped (fails CLOSED), slow paths are
 *    granted over successive spawns, and a converged machine does zero
 *    grant work. The journal expands wedged branches into their children,
 *    so one ungrantable directory never starves its subtree.
 *  - **Network capability**: spawn-time capability SIDs (`internetClient`,
 *    `internetClientServer`, `privateNetworkClientServer`) — no caps means
 *    kernel-dropped outbound. Chosen per spawn from the network policy.
 *  - **stdio**: the child INHERITS the shim's standard handles (plain
 *    `bInheritHandles=TRUE`, no `STARTF_USESTDHANDLES`). The shim is spawned
 *    by node with pipes, so the sandboxed command writes straight into
 *    node's readAll stream — no relay, no redirect files.
 *
 * Everything runs inside a short-lived PowerShell shim (`powershell.exe
 * -NoProfile -NonInteractive -Command <script>`): it loads a cached compiled
 * helper DLL, applies grants, spawns the AppContainer child, reports a
 * status file (the readiness handshake), then waits for the child and exits
 * with its code. Node sees an ordinary pipe child, so readAll/waitForExit/
 * kill keep their exact contract.
 *
 * Hard-won platform facts (verified empirically on Windows 11, standard
 * user — see CHANGELOG [0.6.6]):
 *  - `STARTF_USESTDHANDLES` on an AppContainer child crashes it with
 *    0xC0000142 (DLL init failed) — even with plain file handles. Never set
 *    it; inherit handles instead (proven: child output reaches the parent's
 *    pipes verbatim).
 *  - A custom `lpEnvironment` block is rejected with
 *    ERROR_ENVIRONMENT_NOT_FOUND (203) when the security-capabilities
 *    attribute is present — even a provably well-formed UTF-16 double-null
 *    block. Pass `NULL` and let the child inherit the shim's environment;
 *    node spawns the shim with the request's filtered env, so the child
 *    receives exactly that env either way.
 *  - Lowering a token's integrity with `SetTokenInformation` = denied;
 *    AppContainer is the user-level path to a Low-label token.
 *  - Capabilities must be passed at SPAWN time (profile-time caps do not
 *    reach the token).
 *  - The spawn cwd must live inside a granted directory or cmd reports
 *    "The current directory is invalid".
 *  - Loopback (127.0.0.1) needs a one-time admin `CheckNetIsolation
 *    LoopbackExempt`; we attempt it once per machine and record the outcome
 *    either way.
 *  - Security-descriptor writes are NOT uniformly fast: fresh dirs answer
 *    in ~25ms, profile children take 0.1s-18s, and a directory whose write
 *    was killed mid-flight can wedge so that no writer (icacls or .NET)
 *    ever completes again — only a reboot clears it. Grants therefore must
 *    be bounded; an unbounded ACL phase turns one wedge into a failed
 *    handshake on every spawn.
 *
 * Honesty rules: `windowsAcCapable()` only claims *infrastructure*
 * (PowerShell + compiler/helper present). The per-spawn status handshake is
 * the real gate — if the shim or the AppContainer spawn fails, callers fall
 * back to an unsandboxed spawn with `isSandboxed: false` rather than
 * claiming isolation it does not have.
 */

import { spawn, ChildProcess } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { envFirst, envPathList, envString } from "../../core/src/env_read.js"

/** AppContainer profile name — one per machine, created on first use. */
export const WINDOWS_AC_PROFILE_NAME = "NemoSandbox"

/** Cached helper identity — bump when the C# source changes. */
// Cache key for the compiled helper — bump on ANY C# change so machines
// with a stale DLL recompile instead of silently running old code.
const HELPER_DLL_NAME = "win-ac-v2.dll"

/** Status-handshake deadline: covers the one-time helper compile (~4s). */
const STATUS_TIMEOUT_MS = 60_000
const STATUS_POLL_MS = 50

function powershellPath(): string {
  const root = envFirst(["SystemRoot", "WINDIR"])?.value ?? "C:\\Windows"
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

function helperCacheDir(): string {
  const base = envFirst(["LOCALAPPDATA", "TEMP"])?.value ?? os.tmpdir()
  return path.join(base, "Nemo", "sandbox")
}

// ─── Pure builders (unit-tested) ───

/**
 * Quote one argument per CommandLineToArgvW/CRT rules — the escaping node's
 * own child_process applies (backslash-escape embedded quotes, double
 * trailing backslashes before the closing quote). The result is passed
 * verbatim to `CreateProcessW`, so the shell parses it exactly like it would
 * under the policy-only spawn path.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += "\\".repeat(backslashes) + ch
    backslashes = 0
  }
  out += "\\".repeat(backslashes * 2) + '"'
  return out
}

export function quoteWindowsArgv(argv: string[]): string {
  return argv.map(quoteWindowsArg).join(" ")
}

/** Capability SIDs for a network-enabled spawn (kernel-enforced outbound). */
export function acCapabilitySids(disableNetwork: boolean): string[] {
  if (disableNetwork) return []
  return ["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"]
}

// ─── Capability probe (sync, memoized, test-seamable) ───

type ProbeFn = () => boolean
let probeOverride: ProbeFn | null = null
let probeMemo: boolean | null = null

/**
 * Inject a probe for tests (`null` restores the real one). Vitest suites
 * run with NODE_ENV=test where the default answer is `false` — unit tests
 * must never exec system binaries; the win32 integration test injects
 * `() => true` to exercise the real path.
 */
export function setWindowsAcProbeForTests(fn: ProbeFn | null): void {
  probeOverride = fn
  probeMemo = null
}

/**
 * Infrastructure probe: PowerShell present AND (cached helper DLL OR the
 * .NET Framework compiler that builds it). Fast, no spawning — the real
 * proof is the per-spawn status handshake in `spawnWindowsAcShim`.
 */
export function windowsAcCapable(): boolean {
  if (probeOverride) return probeOverride()
  if (probeMemo !== null) return probeMemo
  probeMemo = computeCapability()
  return probeMemo
}

function computeCapability(): boolean {
  if (process.platform !== "win32") return false
  if (envString("NODE_ENV") === "test") return false
  try {
    if (!fs.existsSync(powershellPath())) return false
    if (fs.existsSync(path.join(helperCacheDir(), HELPER_DLL_NAME))) return true
    const root = envString("WINDIR") ?? "C:\\Windows"
    // Add-Type -OutputAssembly compiles through this csc.exe (C#5 — the
    // embedded helper deliberately sticks to C#5 syntax).
    return fs.existsSync(path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"))
  } catch {
    return false
  }
}

// ─── Shim spawn + status handshake ───

export interface WindowsAcShimRequest {
  command: string[]
  cwd: string
  env: Record<string, string>
  networkDisabled: boolean
  writableRoots: string[]
  denyReadPaths: string[]
  denyWritePaths: string[]
  signal?: AbortSignal
}

export interface WindowsAcShimHandle {
  child: ChildProcess
  pid: number
}

interface StatusPayload {
  ok: boolean
  pid?: number
  error?: string
}

function collectPaths(req: WindowsAcShimRequest): { writePaths: string[]; readPaths: string[] } {
  const writePaths = new Set<string>()
  const readPaths = new Set<string>()
  for (const p of req.writableRoots) writePaths.add(p)
  // The spawn cwd must be granted or cmd refuses to start ("The current
  // directory is invalid").
  writePaths.add(req.cwd)
  const profile = req.env.USERPROFILE
  if (profile) readPaths.add(profile)
  const tmp = req.env.TEMP ?? req.env.TMP
  if (tmp) writePaths.add(tmp)
  const tmpAlt = req.env.TMP ?? req.env.TEMP
  if (tmpAlt) writePaths.add(tmpAlt)
  return { writePaths: [...writePaths], readPaths: [...readPaths] }
}

/**
 * Environment for the shim process: the request's filtered env, with
 * SystemRoot/PATH guaranteed present so powershell.exe can actually start.
 * The AppContainer child inherits this same env (lpEnvironment = NULL), so
 * the sandboxed command sees the filtered environment either way.
 */
function shimEnvFor(req: WindowsAcShimRequest): Record<string, string> {
  const env = { ...req.env }
  if (!env.SystemRoot) env.SystemRoot = envFirst(["SystemRoot", "WINDIR"])?.value ?? "C:\\Windows"
  // envPathList normalises the platform separator and drops blanks, so a PATH
  // containing an empty entry no longer yields a literal "" segment in the
  // child's environment — which Windows resolves against the CURRENT directory.
  if (!env.PATH && !env.Path) env.PATH = envPathList("PATH").join(path.delimiter)
  return env
}

/**
 * Spawn the PowerShell shim and wait for its status handshake.
 *
 * Resolves only once the AppContainer child is genuinely running
 * (`status.json` with `ok: true`); throws on helper error, early shim exit,
 * abort, or handshake timeout — callers fall back to an unsandboxed spawn.
 *
 * The child's stdio arrives directly on `handle.child`'s pipes (the
 * AppContainer process inherits the shim's handles), so wrapping it with
 * `createSpawnedProcess` gives callers byte-identical readAll/waitForExit
 * semantics to every other backend.
 */
export async function spawnWindowsAcShim(req: WindowsAcShimRequest): Promise<WindowsAcShimHandle> {
  if (!windowsAcCapable()) throw new Error("windows appcontainer infrastructure unavailable")
  const ps = powershellPath()
  if (!fs.existsSync(ps)) throw new Error("powershell.exe not found")

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-sbx-"))
  const statusPath = path.join(outDir, "status.json")
  const { writePaths, readPaths } = collectPaths(req)

  const payload = JSON.stringify({
    profileName: WINDOWS_AC_PROFILE_NAME,
    cmdline: quoteWindowsArgv(req.command),
    cwd: req.cwd,
    netMode: req.networkDisabled ? 0 : 1,
    statusPath,
    writePaths,
    readPaths,
    denyReadPaths: req.denyReadPaths,
    denyWritePaths: req.denyWritePaths,
    capabilitySids: acCapabilitySids(req.networkDisabled),
  })

  const child = spawn(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_AC_SHIM_SCRIPT],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: shimEnvFor(req),
      // Not outDir: the shim keeps this directory as its cwd handle for as
      // long as it lives, which would pin status.json's folder against the
      // success-path cleanup below. The script uses absolute paths only.
      cwd: os.tmpdir(),
    },
  )
  // A shim that dies before reading stdin must not crash us on EPIPE.
  child.stdin?.on("error", () => {})
  child.stdin?.write(payload)
  child.stdin?.end()

  // Temp-dir cleanup is best-effort everywhere: Defender can hold status.json
  // for a scan (transient EPERM) and the shim's own cwd lives here. A cleanup
  // failure must never mask a handshake result — least of all turn a proven
  // sandbox into killing the healthy child we just spawned.
  const cleanupOutDir = () => {
    try {
      fs.rmSync(outDir, { recursive: true, force: true })
    } catch {
      /* stray temp dirs are reclaimed by the OS temp cleaner */
    }
  }

  try {
    const status = await waitForStatus(child, statusPath, req.signal)
    if (!status.ok) throw new Error(status.error ?? "windows appcontainer spawn failed")
    cleanupOutDir()
    return { child, pid: child.pid ?? 0 }
  } catch (err) {
    await taskkillTree(child.pid ?? 0).catch(() => {})
    if (!child.killed && child.exitCode === null) child.kill("SIGKILL")
    cleanupOutDir()
    throw err
  }
}

async function waitForStatus(child: ChildProcess, statusPath: string, signal?: AbortSignal): Promise<StatusPayload> {
  return new Promise<StatusPayload>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      signal?.removeEventListener("abort", onAbort)
      child.off("exit", onExit)
      fn()
    }
    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(statusPath)) return
        const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as StatusPayload
        finish(() => resolve(parsed))
      } catch {
        /* partially written — retry */
      }
    }, STATUS_POLL_MS)
    const deadline = setTimeout(() => {
      finish(() => reject(new Error(`windows appcontainer handshake timed out after ${STATUS_TIMEOUT_MS}ms`)))
    }, STATUS_TIMEOUT_MS)
    const onExit = (code: number | null) => {
      // Final check: the write can land after the last poll tick but before
      // the exit event, and rejecting there would lose a healthy handshake.
      try {
        if (fs.existsSync(statusPath)) {
          const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as StatusPayload
          finish(() => resolve(parsed))
          return
        }
      } catch {
        /* unparsable — fall through to the rejection */
      }
      const stderrTail = readStderrTail(child)
      finish(() => reject(new Error(`sandbox helper exited before ready (code ${code}): ${stderrTail}`)))
    }
    const onAbort = () => {
      finish(() => reject(new Error("aborted before sandbox helper was ready")))
    }
    child.on("exit", onExit)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/** Best-effort stderr capture for handshake failure messages. */
function readStderrTail(child: ChildProcess): string {
  try {
    const err = child.stderr as unknown as { read?: () => Buffer | null }
    let out = ""
    for (;;) {
      const chunk = err.read?.()
      if (chunk === null || chunk === undefined || chunk.length === 0) break
      out += chunk.toString("utf8")
      if (out.length > 500) break
    }
    return out.trim().slice(-400)
  } catch {
    return ""
  }
}

/**
 * Kill a whole Windows process tree (shim + AppContainer child).
 * `child.kill()` on Windows is a bare TerminateProcess of the direct child
 * only, which would leave the sandboxed command running.
 */
export async function taskkillTree(pid: number): Promise<void> {
  if (pid <= 0) return
  const taskkill = path.join(
    envFirst(["SystemRoot", "WINDIR"])?.value ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  )
  await new Promise<void>((resolve) => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      killer.kill("SIGKILL")
      resolve()
    }, 5_000)
    killer.on("error", () => {
      clearTimeout(timer)
      resolve()
    })
    killer.on("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// ─── The shim ───

/**
 * PowerShell shim (C# helper embedded below). Protocol:
 *  stdin  = one JSON document (WindowsAcShimRequest payload)
 *  status = status.json written before waiting; ok:false on any failure
 *  stdio  = NOT relayed: the AppContainer child inherits the shim's handles
 *           and streams straight into node's pipes
 *  exit   = the AppContainer child's exit code (255 = helper failure)
 *
 * String.raw keeps Windows paths intact; the script avoids `${` sequences
 * so the TS template never interpolates. The C# source is defined FIRST —
 * PowerShell executes top to bottom, so `$CSharpHelper` must exist before
 * the body references it.
 */
export const WINDOWS_AC_SHIM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$CSharpHelper = @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Text;

public static class NemoAc
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOW
    {
        public int cb;
        public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEXW { public STARTUPINFOW StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr pCapabilities, int capabilityCount, out IntPtr pSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr pSid);
    [DllImport("advapi32.dll")]
    static extern void FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out string stringSid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr procAttrs, IntPtr threadAttrs, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEXW startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint SYNCHRONIZE = 0x00100000;
    const uint STILL_ACTIVE = 259;
    static readonly IntPtr ATTR_SECURITY_CAPABILITIES = (IntPtr)0x00020009;

    public static int EnsureProfile(string name)
    {
        IntPtr created;
        int hr = CreateAppContainerProfile(name, name, "Nemo sandbox", IntPtr.Zero, 0, out created);
        if (created != IntPtr.Zero) FreeSid(created);
        if (hr == 0 || hr == unchecked((int)0x800700B7)) return 0;
        return hr;
    }

    public static string DeriveSid(string name)
    {
        IntPtr sid;
        int hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0 || sid == IntPtr.Zero) return null;
        string sidStr;
        ConvertSidToStringSid(sid, out sidStr);
        FreeSid(sid);
        return sidStr;
    }

    public static int Spawn(string sidStr, string cmdline, string cwd, string[] capabilitySids)
    {
        IntPtr sid;
        if (!ConvertStringSidToSid(sidStr, out sid)) throw new Exception("bad AppContainer SID");

        IntPtr capArray = IntPtr.Zero;
        IntPtr[] capSids = null;
        int capCount = 0;
        if (capabilitySids != null && capabilitySids.Length > 0)
        {
            capArray = Marshal.AllocHGlobal(16 * capabilitySids.Length);
            capSids = new IntPtr[capabilitySids.Length];
            for (int i = 0; i < capabilitySids.Length; i++)
            {
                IntPtr csid;
                if (!ConvertStringSidToSid(capabilitySids[i], out csid))
                {
                    CleanupCaps(capArray, capSids);
                    FreeSid(sid);
                    throw new Exception("bad capability SID " + capabilitySids[i]);
                }
                Marshal.WriteIntPtr(capArray, i * 16, csid);
                Marshal.WriteInt32(capArray, i * 16 + 8, 4); // SE_GROUP_ENABLED
                capSids[i] = csid;
            }
            capCount = capabilitySids.Length;
        }

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attrList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
        {
            CleanupCaps(capArray, capSids);
            FreeSid(sid);
            throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
        }
        var sc = new SECURITY_CAPABILITIES();
        sc.AppContainerSid = sid;
        sc.Capabilities = capArray;
        sc.CapabilityCount = capCount;
        sc.Reserved = 0;
        IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(sc, scPtr, false);
        if (!UpdateProcThreadAttribute(attrList, 0, ATTR_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero))
        {
            int err = Marshal.GetLastWin32Error();
            DeleteProcThreadAttributeList(attrList);
            CleanupCaps(capArray, capSids);
            FreeSid(sid);
            throw new Exception("UpdateProcThreadAttribute failed: " + err);
        }

        // lpEnvironment stays NULL: a custom block is rejected (error 203)
        // alongside the security-capabilities attribute, and the shim's own
        // environment IS the request's filtered env (node spawns it so).
        var siex = new STARTUPINFOEXW();
        siex.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEXW));
        siex.lpAttributeList = attrList;
        var cl = new StringBuilder(cmdline);
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, cl, IntPtr.Zero, IntPtr.Zero, true,
            EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref siex, out pi);

        int lastErr = Marshal.GetLastWin32Error();
        DeleteProcThreadAttributeList(attrList);
        CleanupCaps(capArray, capSids);
        FreeSid(sid);
        if (!ok) throw new Exception("CreateProcessW failed: " + lastErr);
        CloseHandle(pi.hThread);
        // Hold the spawn-time hProcess: once the child exits, a handle-less
        // process object is destroyed immediately and a later OpenProcess
        // fails — which made ExitCode() report 1 for every command. The
        // handle is consumed by ExitCode() or closed with this process.
        s_held[pi.dwProcessId] = pi.hProcess;
        return pi.dwProcessId;
    }

    static void CleanupCaps(IntPtr capArray, IntPtr[] capSids)
    {
        if (capSids != null)
        {
            for (int i = 0; i < capSids.Length; i++) FreeSid(capSids[i]);
        }
        if (capArray != IntPtr.Zero) Marshal.FreeHGlobal(capArray);
    }

    // Spawn-time process handles, keyed by pid (single-threaded shim; the
    // map lives only as long as this PowerShell process).
    static readonly System.Collections.Generic.Dictionary<int, IntPtr> s_held =
        new System.Collections.Generic.Dictionary<int, IntPtr>();

    static IntPtr HeldHandle(int pid)
    {
        IntPtr h;
        return s_held.TryGetValue(pid, out h) ? h : IntPtr.Zero;
    }

    public static bool IsAlive(int pid)
    {
        IntPtr h = HeldHandle(pid);
        if (h == IntPtr.Zero) h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return false;
        uint code;
        bool ok = GetExitCodeProcess(h, out code);
        // Only close handles we opened here; held handles stay for ExitCode.
        if (h != HeldHandle(pid)) CloseHandle(h);
        return ok && code == STILL_ACTIVE;
    }

    public static int ExitCode(int pid)
    {
        IntPtr h = HeldHandle(pid);
        if (h == IntPtr.Zero) h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return 1;
        s_held.Remove(pid);
        uint code;
        bool ok = GetExitCodeProcess(h, out code);
        CloseHandle(h);
        if (!ok) return 1;
        return unchecked((int)code);
    }

    public static void Kill(int pid)
    {
        IntPtr h = HeldHandle(pid);
        if (h != IntPtr.Zero)
        {
            TerminateProcess(h, 124);
            return;
        }
        h = OpenProcess(PROCESS_TERMINATE, false, pid);
        if (h == IntPtr.Zero) return;
        TerminateProcess(h, 124);
        CloseHandle(h);
    }
}
'@
try {
  $cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
  [Console]::Error.Write('bad config on stdin: ' + $_)
  exit 254
}
$statusWritten = $false
function Write-Status([bool]$ok, [string]$errMsg, [int]$childPid) {
  $obj = @{ ok = $ok }
  if ($childPid -gt 0) { $obj.pid = $childPid }
  if ($errMsg) { $obj.error = $errMsg }
  try {
    ($obj | ConvertTo-Json -Compress) | Set-Content -LiteralPath $cfg.statusPath -Encoding ASCII
    $script:statusWritten = $true
  } catch {
    # Never swallow the one write the handshake depends on: node surfaces
    # this on stderr when the helper exits without a status file.
    [Console]::Error.Write('status write failed: ' + $_)
  }
}
$acPid = 0
try {
  $cache = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Nemo\sandbox' } else { Join-Path $env:TEMP 'nemo-sbx-helper' }
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $dll = Join-Path $cache 'win-ac-v2.dll'
  if (-not (Test-Path -LiteralPath $dll)) {
    $tmp = Join-Path $cache ('win-ac-v2-' + [Guid]::NewGuid().ToString('N') + '.dll')
    Add-Type -TypeDefinition $CSharpHelper -Language CSharp -OutputAssembly $tmp -ErrorAction Stop
    try {
      Move-Item -LiteralPath $tmp -Destination $dll -Force -ErrorAction Stop
    } catch {
      if (-not (Test-Path -LiteralPath $dll)) { throw }
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  Add-Type -Path $dll -ErrorAction Stop

  $null = [NemoAc]::EnsureProfile($cfg.profileName)
  $sid = [NemoAc]::DeriveSid($cfg.profileName)
  if (-not $sid) { throw 'cannot derive AppContainer SID' }

  # NTFS grants: deny beats allow, so deny ACEs are applied first, then
  # allow grants (idempotent; repeated grants do not duplicate ACEs).
  #
  # Every icacls call runs with a hard deadline, because real machines
  # disagree wildly about how long a security-descriptor write takes:
  # fresh directories answer in ~25ms, profile children on this machine
  # take 0.1s-18s, and the profile root NEVER completes (three patient
  # attempts: 90s, 120s, 15s — killed mid-write, its SD state wedged).
  # An unbounded grant would stall the handshake until the status timeout
  # and force every spawn into the unsandboxed fallback, so a path that
  # misses its deadline is killed and skipped: skipping fails CLOSED (the
  # sandboxed child simply cannot touch that path), which is the honest
  # direction. Top-level read paths get the short deadline — when healthy
  # they answer in milliseconds and the short bound only costs the wedged
  # ones; children get the long one because they are slow, not stuck.
  $sidSpec = '*' + $sid
  $topTimeoutMs = 8000
  $childTimeoutMs = 15000
  $writeTimeoutMs = 10000
  $denyTimeoutMs = 8000
  $grantBudgetMs = 20000

  function Quote-Path([string]$p) { if ($p -match '\s') { '"' + $p + '"' } else { $p } }

  function Invoke-Icacls([string]$argLine, [int]$timeoutMs) {
    try {
      $exe = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\icacls.exe' } else { 'icacls.exe' }
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $exe
      $psi.Arguments = $argLine
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $proc = [System.Diagnostics.Process]::Start($psi)
      $proc.StandardInput.Close()
      if ($proc.WaitForExit($timeoutMs)) { return $true }
      try { $proc.Kill() } catch { }
      return $false
    } catch { return $false }
  }

  # Directories accept (OI)(CI) inheritance flags, files do not — a file
  # granted with them errors out and gets nothing, so pick the form first.
  function Grant-Path([string]$target, [string]$dirPerm, [int]$timeoutMs) {
    $isDir = $false
    try { $isDir = [System.IO.Directory]::Exists($target) } catch { }
    $perm = if ($isDir) { $dirPerm } else { ($dirPerm -replace '\(OI\)\(CI\)', '') }
    return Invoke-Icacls ((Quote-Path $target) + ' /grant ' + $sidSpec + ':' + $perm + ' /C /Q') $timeoutMs
  }

  # Journal of profile read-grant attempts, keyed by the sorted path set.
  # Entries recorded less than a day ago (OK or FAIL) are not retried: a
  # healthy machine converges to zero grant work per spawn, and a FAIL
  # that a reboot cured gets another chance after the journal goes stale.
  function Read-GrantJournal([string]$path, [string]$header) {
    try {
      if (-not (Test-Path -LiteralPath $path)) { return @{} }
      $item = Get-Item -LiteralPath $path
      $age = (Get-Date) - $item.LastWriteTime
      if ($age.TotalHours -gt 24) { return @{} }
      $lines = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
      if ($lines.Count -lt 1) { return @{} }
      if ($lines[0] -ne $header) { return @{} }
      $map = @{}
      for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = [string]$lines[$i]
        if ($line.StartsWith('OK ')) { $map[$line.Substring(3)] = $true }
        elseif ($line.StartsWith('FAIL ')) { $map[$line.Substring(5)] = $false }
      }
      return $map
    } catch { return @{} }
  }

  function Write-GrantJournal([string]$path, [string]$header, [hashtable]$map) {
    try {
      $sb = New-Object System.Text.StringBuilder
      [void]$sb.AppendLine($header)
      foreach ($k in @($map.Keys)) {
        if ($map[$k]) { [void]$sb.AppendLine('OK ' + $k) }
        else { [void]$sb.AppendLine('FAIL ' + $k) }
      }
      Set-Content -LiteralPath $path -Value $sb.ToString() -Encoding UTF8
    } catch { }
  }

  # Read grants: top paths first; when one wedges, expand into its
  # children (which may accept writes even when the parent does not) up to
  # a fixed depth, skipping reparse points so legacy profile junctions do
  # not re-cost a timeout on their (already visited) targets. The whole
  # pass runs under one budget — whatever did not fit is simply left for
  # the next spawn's journal pass.
  $readHeader = (@($cfg.readPaths) | Where-Object { $_ } | Sort-Object) -join '|'
  $journalPath = Join-Path $cache 'read-grants.journal'
  $journal = Read-GrantJournal $journalPath $readHeader
  $swGrants = [System.Diagnostics.Stopwatch]::StartNew()
  $queue = New-Object System.Collections.Queue
  foreach ($rp in @($cfg.readPaths)) {
    if ($rp -and (Test-Path -LiteralPath $rp)) { $queue.Enqueue(@([string]$rp, 0)) }
  }
  while ($queue.Count -gt 0) {
    if ($swGrants.ElapsedMilliseconds -gt $grantBudgetMs) { break }
    $entry = $queue.Dequeue()
    $target = [string]$entry[0]
    $depth = [int]$entry[1]
    $failed = $false
    if ($journal.ContainsKey($target)) {
      # Recently attempted (OK or FAIL): do not re-run icacls, but a FAIL
      # must still expand — otherwise coverage freezes at whatever the first
      # run's budget happened to grant, and the unvisited siblings are never
      # enqueued again.
      $failed = -not $journal[$target]
    } else {
      $deadline = if ($depth -eq 0) { $topTimeoutMs } else { $childTimeoutMs }
      $ok = Grant-Path $target '(OI)(CI)R' $deadline
      $journal[$target] = $ok
      $failed = -not $ok
    }
    if ($failed -and $depth -lt 2) {
      try {
        foreach ($kid in [System.IO.Directory]::GetFileSystemEntries($target)) {
          try {
            $attrs = [System.IO.File]::GetAttributes($kid)
            if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
          } catch { continue }
          $queue.Enqueue(@([string]$kid, ($depth + 1)))
        }
      } catch { }
    }
  }
  Write-GrantJournal $journalPath $readHeader $journal

  # Write grants (cwd / writable roots) and deny ACEs stay unjournaled:
  # they are per-request and must reflect this request's policy. Bounded
  # like everything else — a wedged workspace path costs one timeout, not
  # the sandbox.
  foreach ($p in @($cfg.writePaths)) {
    if ($p -and (Test-Path -LiteralPath $p)) { [void](Grant-Path $p '(OI)(CI)F' $writeTimeoutMs) }
  }
  foreach ($p in @($cfg.denyReadPaths)) {
    if ($p -and (Test-Path -LiteralPath $p)) { [void](Invoke-Icacls ((Quote-Path $p) + ' /deny ' + $sidSpec + ':(OI)(CI)R /T /C /Q') $denyTimeoutMs) }
  }
  foreach ($p in @($cfg.denyWritePaths)) {
    if ($p -and (Test-Path -LiteralPath $p)) { [void](Invoke-Icacls ((Quote-Path $p) + ' /deny ' + $sidSpec + ':(OI)(CI)W /T /C /Q') $denyTimeoutMs) }
  }

  # One-time best-effort loopback exemption (needs admin; marker records the
  # attempt either way so we never retry-spam).
  if ([int]$cfg.netMode -ne 0) {
    $marker = Join-Path $cache 'loopback.done'
    if (-not (Test-Path -LiteralPath $marker)) {
      & (Join-Path $env:SystemRoot 'System32\CheckNetIsolation.exe') LoopbackExempt -a -n=$cfg.profileName 2>$null | Out-Null
      'done' | Set-Content -LiteralPath $marker -Encoding ASCII
    }
  }

  $acPid = [NemoAc]::Spawn($sid, $cfg.cmdline, $cfg.cwd, $cfg.capabilitySids)
  if ($acPid -le 0) { throw 'AppContainer spawn returned no pid' }
  Write-Status $true '' $acPid

  # The child streams straight into the shim's inherited pipe handles; all
  # we do is wait and mirror its exit code.
  while ([NemoAc]::IsAlive($acPid)) { Start-Sleep -Milliseconds 100 }
  $code = [NemoAc]::ExitCode($acPid)
  exit $code
} catch {
  if (-not $script:statusWritten) { Write-Status $false ('sandbox helper failed: ' + $_) $acPid }
  [Console]::Error.Write('sandbox helper failed: ' + $_)
  if ($acPid -gt 0) { try { [NemoAc]::Kill($acPid) } catch { } }
  exit 255
}
`

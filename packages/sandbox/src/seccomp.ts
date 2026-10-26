/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Seccomp-BPF filter generation, and the mount masking that goes with it.
 *
 * Why this exists
 * ---------------
 * The namespace sandbox Nemo builds (via bubblewrap) is a boundary, not a
 * wall. Namespaces are the kernel honouring a request; a kernel bug, an
 * unprivileged-kernel hole, or a binary that finds a side channel walks out of
 * whatever the namespace allows. Seccomp is the layer underneath that: once
 * installed, the listed syscalls fail for the process whether or not it is still
 * in the namespace it was supposed to be confined to.
 *
 * That is defence in depth rather than a substitute. Losing a namespace should
 * degrade isolation, not end it.
 *
 * Codex installs a seccomp filter alongside `PR_SET_NO_NEW_PRIVS` for exactly
 * this reason. Nemo had neither, so its Linux sandbox was one kernel bug deep
 * from unrestricted execution.
 *
 * Why the filter is GENERATED here rather than shipped as a binary
 * -----------------------------------------------------------------
 * A precompiled `.bpf` blob is opaque, un-reviewable, and arch-specific in a way
 * that is invisible from the file list. Generating it from a policy means the
 * denylist is readable, the arch handling is explicit, and the tests can assert
 * the actual instructions without a kernel, root, or `seccompiler`.
 *
 * The encoding
 * ------------
 * A seccomp filter is a classic-BPF program over `struct seccomp_data`:
 *
 *   offset 0  int   nr                 the syscall number
 *   offset 4  u32   arch               AUDIT_ARCH_*, checked first
 *   offset 8  u64   instruction_pointer
 *   offset 16 u64   args[6]
 *
 * The program loads the syscall number, compares it against each denied value,
 * and RETURNS on a hit; otherwise it falls through to RET_ALLOW. Checking `arch`
 * before the syscall number is not optional — without it a 32-bit x86 binary can
 * issue `int 0x80` with numbers that mean something entirely different, and
 * bypass the whole filter.
 *
 * Everything here is a pure function over plain data. Nothing is installed and
 * nothing needs privilege, which is what makes the interesting parts testable.
 */

/* ------------------------------------------------------------------ *
 * BPF encoding
 * ------------------------------------------------------------------ */

/** Classic BPF opcodes used below. */
const BPF_LD = 0x00
const BPF_W = 0x00
const BPF_ABS = 0x20
const BPF_JMP = 0x05
const BPF_JEQ = 0x10
const BPF_K = 0x00
const BPF_RET = 0x06

/*
 * A classic-BP instruction is `struct sock_filter` from linux/filter.h:
 *
 *     15..0   code   (16-bit opcode)
 *     23..16  jt     (jump-true offset, JUMP only)
 *     31..24  jf     (jump-false offset, JUMP only)
 *     63..32  k      (32-bit constant)
 *
 * `k` sits in the TOP 32 bits. Two consequences drove the representation here:
 *
 *  1. `AUDIT_ARCH_X86_64` is 0xC000003e and `SECCOMP_RET_KILL_PROCESS` is
 *     0x80000000. A layout with a 16-bit `k` silently truncates both to 0x003e
 *     and 0x0000 — the first rejects every legitimate syscall, the second emits
 *     an action the kernel does not recognise.
 *  2. The word is 64 bits, which does NOT fit in a JavaScript number: 2^53 is the
 *     exact-integer limit, and a `k` of 0x80000000 pushes the word to ~9.2e18.
 *     Packing it into a `number` loses precision silently, which is worse than
 *     not packing it.
 *
 * So an instruction is an OBJECT here, and the packed word is produced only by
 * `encodeFilter`, which writes the real little-endian bytes. Nothing downstream
 * ever has to trust a 64-bit value in a double.
 */
export interface FilterInstruction {
  /** 16-bit opcode. */
  code: number
  /** Jump-true offset. Always 0 for a non-JUMP instruction. */
  jt: number
  /** Jump-false offset. Always 0 for a non-JUMP instruction. */
  jf: number
  /** 32-bit constant, kept unsigned so `0x80000000` survives. */
  k: number
}

const LD_W_ABS = BPF_LD | BPF_W | BPF_ABS
const JEQ_K = BPF_JMP | BPF_JEQ | BPF_K
const RET_K = BPF_RET | BPF_K

const STMT = (code: number, k: number): FilterInstruction => ({ code, jt: 0, jf: 0, k })
const JUMP = (code: number, k: number, jt: number, jf: number): FilterInstruction => ({ code, jt, jf, k })

/**
 * Encode instructions into the 8-byte little-endian words the kernel reads.
 *
 * This is the only place a packed 64-bit word is produced, and it does the
 * packing in a byte buffer rather than in arithmetic — which is what keeps
 * `0x80000000` exact.
 */
export function encodeFilter(program: readonly FilterInstruction[]): Buffer {
  const out = Buffer.alloc(program.length * 8)
  program.forEach((insn, i) => {
    const at = i * 8
    out.writeUInt16LE(insn.code & 0xffff, at)
    out.writeUInt8(insn.jt & 0xff, at + 2)
    out.writeUInt8(insn.jf & 0xff, at + 3)
    out.writeUInt32LE(insn.k >>> 0, at + 4)
  })
  return out
}

/** `SECCOMP_RET_*` actions, with the data bits shifted into place. */
export const SECCOMP_RET_KILL_PROCESS = 0x80000000
export const SECCOMP_RET_ERRNO = 0x00050000
export const SECCOMP_RET_ALLOW = 0x7fff0000

/** Offsets into `struct seccomp_data` on 64-bit. */
const OFFSET_NR = 0
const OFFSET_ARCH = 4

/** `AUDIT_ARCH_*`, which identifies the syscall ABI in use. */
export const AUDIT_ARCH_X86_64 = 0xc000003e
export const AUDIT_ARCH_AARCH64 = 0xc00000b7
export const AUDIT_ARCH_I386 = 0x40000003

export type Arch = "x86_64" | "aarch64"

/** The audit arch value for a target. */
export function auditArchFor(arch: Arch): number {
  return arch === "x86_64" ? AUDIT_ARCH_X86_64 : AUDIT_ARCH_AARCH64
}

/**
 * Syscalls denied by default.
 *
 * Grouped by what they defeat, because "a list of numbers" does not survive a
 * review:
 *
 *  - **Escape the namespace.** `mount`, `umount2`, `pivot_root`, `chroot`,
 *    `unshare`, `setns`. A sandbox whose whole value is the namespace must not
 *    let the process build or enter another one.
 *  - **Inject into another process.** `ptrace`, `process_vm_readv`,
 *    `process_vm_writev`. These reach OUT of the sandbox — into the parent CLI,
 *    or another agent — which is the one thing a per-spawn sandbox must not
 *    permit regardless of namespaces.
 *  - **Reload the kernel's own policy.** `bpf`, `perf_event_open`,
 *    `userfaultfd`. A filter that can be replaced or evaded is not a filter.
 *  - **Persist past the process.** `kexec_load`, `init_module`,
 *    `delete_module`, `reboot`.
 *  - **Reach the keyring.** `add_key`, `request_key`, `keyctl`. The agent holds
 *    provider credentials in the environment; the kernel keyring is the other
 *    place they can be.
 *  - **Cross-container attacks.** `kcmp`, `open_by_handle_at`, `name_to_handle_at`.
 *
 * Note what is NOT here: no filesystem or network syscalls. Those are the
 * namespace's job, and denying them as well would break ordinary tools while
 * adding nothing — the boundary being defended is escape, not use.
 */
export const DENIED_SYSCALLS: Readonly<Record<Arch, readonly number[]>> = {
  x86_64: [
    // escape the namespace
    155, // pivot_root
    161, // chroot
    165, // mount
    166, // umount2
    272, // unshare
    308, // setns
    // inject into another process
    101, // ptrace
    310, // process_vm_readv
    311, // process_vm_writev
    // reload the kernel's own policy
    321, // bpf
    298, // perf_event_open
    323, // userfaultfd
    // persist past the process
    246, // kexec_load
    175, // init_module
    176, // delete_module
    169, // reboot
    // reach the keyring
    248, // add_key
    249, // request_key
    250, // keyctl
    // cross-container attacks
    312, // kcmp
    304, // open_by_handle_at
    303, // name_to_handle_at
  ],
  aarch64: [
    // escape the namespace
    41, // pivot_root
    51, // chroot
    40, // mount
    39, // umount2
    97, // unshare
    268, // setns
    // inject into another process
    117, // ptrace
    270, // process_vm_readv
    271, // process_vm_writev
    // reload the kernel's own policy
    280, // bpf
    241, // perf_event_open
    282, // userfaultfd
    // persist past the process
    104, // kexec_load
    105, // init_module
    106, // delete_module
    142, // reboot
    // reach the keyring
    217, // add_key
    218, // request_key
    219, // keyctl
    // cross-container attacks
    273, // kcmp
    265, // open_by_handle_at
    264, // name_to_handle_at
  ],
}

export interface FilterOptions {
  arch: Arch
  /** Overrides the default denylist. An empty list yields an allow-everything program. */
  deny?: readonly number[]
  /** `KILL_PROCESS` (default) or `ERRNO`, so a denied call fails instead of killing. */
  onDenied?: "kill" | "errno"
  /** Errno returned when `onDenied` is `errno`. */
  errno?: number
}

/**
 * Build the BPF program.
 *
 * Layout:
 *
 *   0  LD  [arch]
 *   1  JEQ arch, 0, <kill>          foreign ABI → deny
 *   2  LD  [nr]
 *   3  for each denied syscall: JEQ nr, 0, <next>; RET <action>
 *   n  RET ALLOW
 *
 * The arch check jumps STRAIGHT to the action because a jump target is relative
 * and the number of deny rules is not known until this function has run.
 */
export function buildFilter(options: FilterOptions): FilterInstruction[] {
  const archValue = auditArchFor(options.arch)
  const deny = options.deny ?? DENIED_SYSCALLS[options.arch]
  const action =
    options.onDenied === "errno"
      ? SECCOMP_RET_ERRNO | (options.errno ?? 1)
      : SECCOMP_RET_KILL_PROCESS

  // Each deny rule is two instructions: a compare that skips the RET when the
  // syscall does not match, then the RET itself. The skip is 1, the size of the
  // RET, so the program continues into the next comparison.
  const denyRules: FilterInstruction[] = []
  for (const nr of dedupe(deny)) {
    denyRules.push(JUMP(JEQ_K, nr, 0, 1))
    denyRules.push(STMT(RET_K, action))
  }

  // The arch comparison jumps forward to the FIRST deny RET. Its distance is
  // known here because the deny rules are built first — which is the whole reason
  // this is one function and not two passes. A relative jump counts from the
  // instruction AFTER itself, so from index 1 the target (index 3) is at +2.
  const archJumpForward = 2
  if (archJumpForward <= 0 || archJumpForward > 255) {
    // 255 is the classic-BP `jt` field width. Truncating it would turn the arch
    // check into a no-op, which silently allows a 32-bit bypass of every rule.
    throw new RangeError(`seccomp arch jump out of range: ${archJumpForward}`)
  }

  return [
    STMT(LD_W_ABS, OFFSET_ARCH),
    // A foreign ABI is DENIED rather than allowed: an i386 `int 0x80` carries a
    // different syscall number for the same intent, so allowing it walks straight
    // past every comparison below.
    JUMP(JEQ_K, archValue, archJumpForward, 0),
    STMT(LD_W_ABS, OFFSET_NR),
    ...denyRules,
    STMT(RET_K, SECCOMP_RET_ALLOW),
  ]
}

function dedupe(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/**
 * Index of the first deny rule.
 *
 * Three instructions precede the rules: load `arch`, compare `arch`, load `nr`.
 * Decoding has to start here, not one earlier — starting at 2 reads the `nr`
 * load as if it were a comparison and silently reports every filter as denying
 * nothing, which is the worst possible direction for a security check to fail in.
 */
const FIRST_RULE = 3

/**
 * Whether a syscall number is denied by a program.
 *
 * Used by the tests to decode what was generated without a kernel. It reads the
 * program's own structure rather than re-deriving it from the policy, so a
 * generation bug shows up as a disagreement between the two rather than as a
 * test that agrees with itself.
 */
export function programDenies(program: readonly FilterInstruction[], syscallNr: number): boolean {
  for (let i = FIRST_RULE; i + 1 < program.length; i += 2) {
    const insn = program[i] as FilterInstruction
    if (insn.code === JEQ_K && insn.k === syscallNr) return true
  }
  return false
}

/** Extract the syscall numbers a program compares against. */
export function programDeniedList(program: readonly FilterInstruction[]): number[] {
  const out: number[] = []
  for (let i = FIRST_RULE; i + 1 < program.length; i += 2) {
    const insn = program[i] as FilterInstruction
    if (insn.code === JEQ_K) out.push(insn.k)
  }
  return out
}



/* ------------------------------------------------------------------ *
 * Mount masking
 * ------------------------------------------------------------------ */

/**
 * Paths hidden from inside the sandbox.
 *
 * Each entry names a path the sandbox should present as an EMPTY tmpfs rather
 * than bind-mounting the real one. The reason per entry matters: a tmpfs at
 * `/proc/self/environ` hides the environment, and the environment is where every
 * provider API key lives.
 */
export interface MaskRule {
  path: string
  why: string
}

export const DEFAULT_MASKS: readonly MaskRule[] = [
  { path: "/root/.ssh", why: "private keys" },
  { path: "/root/.aws", why: "cloud credentials" },
  { path: "/root/.config/gcloud", why: "cloud credentials" },
  { path: "/root/.kube", why: "cluster credentials" },
  { path: "/root/.docker", why: "registry credentials" },
  { path: "/root/.netrc", why: "stored passwords" },
  { path: "/root/.npmrc", why: "registry tokens" },
  { path: "/root/.git-credentials", why: "stored passwords" },
]

/**
 * Build the `--tmpfs` flags for a mask list.
 *
 * A tmpfs, not a bind of `/dev/null`: a file masked as a device node behaves
 * differently for read and for write, and some tools treat a read that returns
 * empty as "missing" while others loop on it. An empty directory is predictable
 * for both.
 *
 * Paths are sorted and de-duplicated so the argument list is stable — a spawn
 * command that differs run to run defeats any caching of it, and makes a failing
 * spawn impossible to compare against a working one.
 */
export function maskFlags(masks: readonly MaskRule[] = DEFAULT_MASKS): string[] {
  const unique = [...new Set(masks.map((m) => m.path))].sort()
  const out: string[] = []
  for (const path of unique) out.push("--tmpfs", path)
  return out
}

/**
 * Whether a mask list would hide a given path.
 *
 * Segment-aware, so masking `/root/.ssh` does not also hide `/root/.sshd`. That
 * false positive is the reason a prefix comparison is wrong here, exactly as it
 * was for the filesystem policy.
 */
export function isMasked(masks: readonly MaskRule[], path: string): boolean {
  return masks.some((m) => {
    const root = m.path.endsWith("/") ? m.path.slice(0, -1) : m.path
    return path === root || path.startsWith(`${root}/`)
  })
}

/**
 * Whether a path should be masked GIVEN an environment.
 *
 * The agent's home is not always `/root` — it is wherever the process runs, so
 * a hardcoded list silently misses on any non-root install. The rules are
 * rewritten against the real home before use, which is the difference between a
 * protection that applies and one that is believed to.
 */
export function masksForHome(home: string, masks: readonly MaskRule[] = DEFAULT_MASKS): MaskRule[] {
  // Trailing separators are stripped, and the join is not a bare concatenation:
  // `os.homedir()` on some platforms returns "/home/user/", and `${home}${suffix}`
  // then produces "/home/user//.ssh". bwrap would treat that as a different path
  // than the one the file is actually at, so the mask would apply to nothing and
  // still look configured.
  const base = home.replace(/[\\/]+$/, "")
  if (base === "/root") return [...masks]
  return masks.map((m) => ({ path: `${base}${m.path.slice("/root".length)}`, why: m.why }))
}
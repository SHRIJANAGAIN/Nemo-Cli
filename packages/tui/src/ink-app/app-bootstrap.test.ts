/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import React, { useEffect } from "react"
import { PassThrough } from "node:stream"
import { Box, render } from "ink"

import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  convertToAgentMessages,
  createAgentConfig,
  enterAltScreen,
  leaveAltScreen,
  liveViewportRows,
  MIN_USABLE_COLUMNS,
  MIN_USABLE_ROWS,
  readLiveWindowSize,
  resolveAltScreen,
  syncWindowSizeCache,
  useResizingFlag,
  WELCOME_COMPACT_BELOW_ROWS,
  welcomeFillRows,
  welcomeLogoCompact,
} from "./app-bootstrap.js"
import type { TrayambakMessage } from "./types.js"

/**
 * app-bootstrap is the state-free half of App.tsx. These tests pin the two
 * behavioral contracts that have regressed before in live use:
 *  - createAgentConfig: optional fields must PASS THROUGH (dropping
 *    `provider` silently rebuilt every agent as NVIDIA → HF logins 401'd;
 *    dropping `developerMode` reset /devmode on every restart; dropping
 *    `githubLogin` rebuilt every fresh session logged-out).
 *  - convertToAgentMessages: history rebuilds must keep tool context
 *    (toolCall + result rows) and thinking parts across turns.
 */
describe("createAgentConfig passthrough", () => {
  test("provider survives the rebuild when present, is not forced when absent", () => {
    expect(createAgentConfig({ provider: "huggingface" }).provider).toBe("huggingface")
    expect(createAgentConfig({}).provider).toBeUndefined()
  })

  test("session budget survives the rebuild (absent stays absent) (#64)", () => {
    // Dropping budget here silently deactivated every configured/env cap in
    // TUI sessions — the loop only applies run.config.budget.
    expect(createAgentConfig({ budget: "6k" }).budget).toBe("6k")
    expect(createAgentConfig({}).budget).toBeUndefined()
  })

  test("reasoningEffort / permissions / developerMode pass through unchanged", () => {
    const permissions = { allow: ["Bash(git *)"], ask: [], deny: [] } as never
    const developerMode = { enabled: true, gated: true } as never
    const cfg = createAgentConfig({ reasoningEffort: "high", permissions, developerMode })
    expect(cfg.reasoningEffort).toBe("high")
    expect(cfg.permissions).toBe(permissions)
    expect(cfg.developerMode).toBe(developerMode)
  })

  test("explicit overrides win over defaults", () => {
    const cfg = createAgentConfig({ model: "qwen3", baseUrl: "http://router:8000", maxTurns: 3 })
    expect(cfg.model).toBe("qwen3")
    expect(cfg.baseUrl).toBe("http://router:8000")
    expect(cfg.maxTurns).toBe(3)
  })

  test("operator identity survives the rebuild (absent stays absent)", () => {
    const named = createAgentConfig({
      githubLogin: "octocat",
      licenseKey: "1102-AAAA-BBBB-CCCC",
      licenseServerUrl: "https://skt.sktailabs.in",
    })
    expect(named.githubLogin).toBe("octocat")
    expect(named.licenseKey).toBe("1102-AAAA-BBBB-CCCC")
    expect(named.licenseServerUrl).toBe("https://skt.sktailabs.in")
    const anon = createAgentConfig({})
    expect(anon.githubLogin).toBeUndefined()
    expect(anon.licenseKey).toBeUndefined()
    expect(anon.licenseServerUrl).toBeUndefined()
  })

  test("mcpServers + skillsDir survive the rebuild (absent stays absent)", () => {
    const mcpServers = { gh: { command: ["npx", "-y", "x"] } }
    const cfg = createAgentConfig({ mcpServers, skillsDir: "/skills" })
    expect(cfg.mcpServers).toBe(mcpServers)
    expect(cfg.skillsDir).toBe("/skills")
    const bare = createAgentConfig({})
    expect(bare.mcpServers).toBeUndefined()
    expect(bare.skillsDir).toBeUndefined()
  })

  test("toolsets: empty default list fills the stock set, a real set passes through", () => {
    const filled = createAgentConfig({})
    expect(filled.toolsets?.defaults?.length).toBeGreaterThan(0)
    expect(filled.toolsets?.disabled).toEqual([])

    const custom = { defaults: ["core"], disabled: ["ops"], platform: {} }
    expect(createAgentConfig({ toolsets: custom }).toolsets).toBe(custom)
  })
})

describe("liveViewportRows", () => {
  test("the live terminal size wins over one-render-old React state", () => {
    // Ink re-renders on resize from its own listener before useTerminalRows'
    // setState lands. Sizing the frame from state paints the OLD window for
    // one render — after a shrink that frame is taller than the viewport and
    // every repaint scrolls clones into scrollback.
    expect(liveViewportRows(27, 40)).toBe(27)
    expect(liveViewportRows(40, 27)).toBe(40)
  })

  test("0/undefined (console reattach) falls back to state, never to height 0", () => {
    expect(liveViewportRows(0, 30)).toBe(30)
    expect(liveViewportRows(undefined, 30)).toBe(30)
  })
})

describe("welcomeFillRows", () => {
  test("the idle frame exactly fills the viewport: border 2 + welcome 13 + footer 3 + composer 2", () => {
    // Exact fit never scrolls; anything taller scrolls once per repaint and
    // that scroll IS the clone mechanism.
    expect(welcomeFillRows(27)).toBe(6)
    expect(welcomeFillRows(40)).toBe(19)
    expect(welcomeFillRows(60)).toBe(30)
  })

  test("never negative, capped so giant terminals do not grow filler forever", () => {
    expect(welcomeFillRows(10)).toBe(0)
    expect(welcomeFillRows(200)).toBe(30)
  })
})

describe("welcomeLogoCompact", () => {
  test("falls back to the one-line mark only where the lockup cannot fit", () => {
    expect(welcomeLogoCompact(WELCOME_COMPACT_BELOW_ROWS - 1)).toBe(true)
    expect(welcomeLogoCompact(WELCOME_COMPACT_BELOW_ROWS)).toBe(false)
    expect(welcomeLogoCompact(40)).toBe(false)
  })
})

describe("readLiveWindowSize", () => {
  test("returns the syscall size when it is sane", () => {
    expect(readLiveWindowSize({ getWindowSize: () => [120, 30] })).toEqual({ columns: 120, rows: 30 })
  })

  test("null without a syscall, on throw, and on nonsense values", () => {
    expect(readLiveWindowSize({})).toBeNull()
    expect(readLiveWindowSize(undefined)).toBeNull()
    expect(
      readLiveWindowSize({
        getWindowSize: () => {
          throw new Error("headless")
        },
      }),
    ).toBeNull()
    for (const bad of [
      [0, 30],
      [120, 0],
      [-5, 30],
      ["x", 30],
      [120],
      "120x30",
    ]) {
      expect(readLiveWindowSize({ getWindowSize: () => bad })).toBeNull()
    }
  })

  test("refuses sub-usable sizes so paints keep last-good geometry", () => {
    // Minimize-to-taskbar transiently reports 0x0; a letterbox window fits
    // nothing readable. Accepting either would collapse every paint (and
    // every erase count with it), and the restore repaint would then erase
    // only those few rows — permanent residue no later repaint touches.
    expect(readLiveWindowSize({ getWindowSize: () => [10, 30] })).toBeNull()
    expect(readLiveWindowSize({ getWindowSize: () => [120, 5] })).toBeNull()
    expect(readLiveWindowSize({ getWindowSize: () => [0, 0] })).toBeNull()
    expect(readLiveWindowSize({ getWindowSize: () => [MIN_USABLE_COLUMNS, MIN_USABLE_ROWS] })).toEqual({
      columns: MIN_USABLE_COLUMNS,
      rows: MIN_USABLE_ROWS,
    })
  })
})

describe("syncWindowSizeCache", () => {
  test("overwrites stale cache with syscall truth and reports the change", () => {
    const stdout = { columns: 209, rows: 51, getWindowSize: () => [110, 26] }
    expect(syncWindowSizeCache(stdout)).toBe(true)
    expect(stdout.columns).toBe(110)
    expect(stdout.rows).toBe(26)
  })

  test("quiet when already in sync or when there is nothing to read", () => {
    expect(syncWindowSizeCache({ columns: 110, rows: 26, getWindowSize: () => [110, 26] })).toBe(false)
    expect(syncWindowSizeCache({ columns: 110, rows: 26 })).toBe(false)
  })
})

describe("App frame wiring (source pins the live-geometry contract)", () => {  // The helpers above are worthless if App sizes its frame from raw React
  // state: Ink re-renders on resize before useTerminalRows' setState lands, so
  // one stale render paints a taller-than-viewport frame and every repaint
  // after it scrolls clones into scrollback. This pins the three call sites
  // the same way ink-repl-startup-clear pins the resize-guard attach.
  const appSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), "packages", "tui", "src", "ink-app", "App.tsx"), "utf8")

  test("root frame height follows live rows, not state rows", () => {
    expect(appSource()).toContain("liveViewportRows(stdout?.rows, rows)")
    expect(appSource()).toContain("height={Math.max(1, viewportRows - 1)}")
  })

  test("welcome fill and compact mark follow the same live rows", () => {
    expect(appSource()).toContain("welcomeFillRows(viewportRows)")
    expect(appSource()).toContain("welcomeLogoCompact(viewportRows)")
  })

  test("narrow chrome while a resize settles (fewer full-width rows to reflow)", () => {
    // Shrink-drags re-flow full-width rows into scrollback terminal-side, so
    // the welcome block paints short until quiet: unpadded logo (width 0
    // disables padLogoToTheme) and no fill rows. Borders stay — cheap rows.
    expect(appSource()).toContain("useResizingFlag()")
    expect(appSource()).toContain("resizing ? 0")
  })

  test("App registers the settle reprint that rebuilds Static after 3J", () => {
    // The guard wipes viewport+scrollback at settle and invokes the slot;
    // App answers by remounting Static so the transcript reprints from item
    // 0 — history survives clean instead of cloned. Unregistered on unmount
    // so a dead App never reprints into a later owner.
    const src = appSource()
    expect(src).toContain("registerSettleReprintHandler(")
    expect(src).toContain("setStaticEpoch((e) => e + 1)")
  })
})

describe("convertToAgentMessages", () => {
  test("system and user rows map one-to-one", () => {
    const out = convertToAgentMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ] as TrayambakMessage[])
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ])
  })

  test("assistant tool row rebuilds the toolCall part and its tool result", () => {
    const out = convertToAgentMessages([
      {
        role: "assistant",
        content: '{"command":"ls"}',
        toolCallId: "call_1",
        toolName: "bash",
        result: "file.txt",
        isError: false,
      },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
      stopReason: "tool_use",
    })
    expect(out[1]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "file.txt" }],
      isError: false,
    })
  })

  test("assistant tool row WITHOUT a result keeps the call only (no phantom tool turn)", () => {
    const out = convertToAgentMessages([
      { role: "assistant", content: "{}", toolCallId: "c", toolName: "read" },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "tool_use" })
  })

  test("malformed / non-object tool args degrade to { value } instead of throwing", () => {
    const malformed = convertToAgentMessages([
      { role: "assistant", content: "not json {", toolCallId: "c", toolName: "t" },
    ] as TrayambakMessage[])
    const call = malformed[0]?.content
    expect(Array.isArray(call) && call[0] && typeof call[0] === "object" && "arguments" in call[0]).toBe(true)
    expect(Array.isArray(call) ? (call[0] as { arguments: unknown }).arguments : null).toEqual({
      value: "not json {",
    })

    const nonObject = convertToAgentMessages([
      { role: "assistant", content: "[1,2]", toolCallId: "c", toolName: "t" },
    ] as TrayambakMessage[])
    const call2 = nonObject[0]?.content
    expect(Array.isArray(call2) ? (call2[0] as { arguments: unknown }).arguments : null).toEqual({
      value: [1, 2],
    })
  })

  test("thinking rides along ahead of the text part", () => {
    const out = convertToAgentMessages([
      { role: "assistant", content: "answer", thinking: "hmm…" },
    ] as TrayambakMessage[])
    expect(out[0]?.content).toEqual([
      { type: "thinking", text: "hmm…" },
      { type: "text", text: "answer" },
    ])
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "end_turn" })
  })

  test("tool rows without both ids are dropped; identified tool rows pass through", () => {
    const out = convertToAgentMessages([
      { role: "tool", content: "orphan" },
      { role: "tool", content: "ok", toolCallId: "t1", toolName: "read", isError: true },
    ] as TrayambakMessage[])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      role: "tool",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: true,
    })
  })
})

describe("useResizingFlag", () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  function openStdio() {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {},
    }) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true, columns: 120, rows: 30,
    }) as unknown as NodeJS.WriteStream & {
      emit(event: "resize"): boolean;
      columns: number;
      rows: number;
    };
    return { stdin, stdout };
  }

  test("true on resize, false again after quiet (narrow chrome window)", async () => {
    const seen: boolean[] = [];
    function Probe(): React.ReactElement {
      const resizing = useResizingFlag(40);
      useEffect(() => {
        seen.push(resizing);
      }, [resizing]);
      return React.createElement(Box, null);
    }
    const { stdin, stdout } = openStdio();
    const instance = render(React.createElement(Probe), {
      stdin, stdout, patchConsole: false,
    });
    await wait(80);
    // Settles to false without any resize (initial mount excluded: only
    // transitions are recorded... first effect run records initial false).
    (stdout as unknown as { emit: (e: "resize") => void }).emit("resize");
    await wait(80);
    (stdout as unknown as { emit: (e: "resize") => void }).emit("resize");
    await wait(120);
    instance.unmount();
    // true at least once (the resize registered), false again at the end
    // (quiet settled). Exact counts would couple to React's batching.
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe("resolveAltScreen", () => {
  test("default ON: no flag, no env — clone-free buffer is the default path", () => {
    expect(resolveAltScreen({})).toBe(true);
    expect(resolveAltScreen({ env: {} })).toBe(true);
  });

  test("an explicitly set env var decides by truthiness — empty counts as opt-out", () => {
    expect(resolveAltScreen({ env: { TRAYAMBAK_ALT_SCREEN: "" } })).toBe(false);
    for (const v of ["1", "true", "TRUE", "yes", "on", " Y "]) {
      expect(resolveAltScreen({ env: { TRAYAMBAK_ALT_SCREEN: v } }), v).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "maybe"]) {
      expect(resolveAltScreen({ env: { TRAYAMBAK_ALT_SCREEN: v } }), v).toBe(false);
    }
  });

  test("explicit CLI flag wins over env either way", () => {
    expect(resolveAltScreen({ flag: true, env: { TRAYAMBAK_ALT_SCREEN: "0" } })).toBe(true);
    expect(resolveAltScreen({ flag: false, env: { TRAYAMBAK_ALT_SCREEN: "1" } })).toBe(false);
    expect(resolveAltScreen({ flag: "true", env: {} })).toBe(true);
    expect(resolveAltScreen({ flag: "false", env: { TRAYAMBAK_ALT_SCREEN: "1" } })).toBe(false);
  });
});

describe("alt-screen sequences", () => {
  test("enter switches to the alternate buffer and nothing else", () => {
    const written = [];
    enterAltScreen((chunk) => written.push(chunk));
    expect(written).toEqual(["\x1b[?1049h"]);
    expect(ALT_SCREEN_ENTER).toBe("\x1b[?1049h");
  });

  test("leave restores the main buffer AND the caret", () => {
    // The app hides the hardware caret for its lifetime and process.exit
    // skips React's unmount cleanup, so leaving without ?25h would hand the
    // shell back caret-less after every alt-screen session.
    const written = [];
    leaveAltScreen((chunk) => written.push(chunk));
    expect(written).toEqual(["\x1b[?1049l\x1b[?25h"]);
    expect(ALT_SCREEN_LEAVE).toBe("\x1b[?1049l\x1b[?25h");
  });
});

describe("settle reprint slot", () => {
  test("single owner: register invokes, replace swaps, unregister silences", async () => {
    const { registerSettleReprintHandler, requestSettleReprint } = await import("./app-bootstrap.js");
    const seen = [];
    registerSettleReprintHandler(() => seen.push("a"));
    requestSettleReprint();
    registerSettleReprintHandler(() => seen.push("b"));
    requestSettleReprint();
    registerSettleReprintHandler(undefined);
    requestSettleReprint();
    expect(seen).toEqual(["a", "b"]);
  });
});

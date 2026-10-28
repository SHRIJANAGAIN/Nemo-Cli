/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  agentMessagesToRows,
  convertToAgentMessages,
  createAgentConfig,
  enterAltScreen,
  leaveAltScreen,
  liveViewportRows,
  MIN_USABLE_COLUMNS,
  MIN_USABLE_ROWS,
  readLiveWindowSize,
  resolveAltScreen,
  resumeQuery,
  syncWindowSizeCache,
  useResizingFlag,
  WELCOME_COMPACT_BELOW_ROWS,
  welcomeFillRows,
  welcomeLogoCompact,
} from "./app-bootstrap.js"
import type { NemoMessage } from "./types.js"

/**
 * app-bootstrap is the state-free half of App.tsx. These tests pin the two
 * behavioral contracts that have regressed before in live use:
 *  - createAgentConfig: optional fields must PASS THROUGH (dropping
 *    `provider` silently rebuilt every agent as NVIDIA → a local-model
 *    session 401'd; dropping `developerMode` reset /devmode on every
 *    restart; dropping `githubLogin` rebuilt every fresh session logged-out).
 *  - convertToAgentMessages: history rebuilds must keep tool context
 *    (toolCall + result rows) and thinking parts across turns.
 */
describe("createAgentConfig passthrough", () => {
  test("provider survives the rebuild when present, is not forced when absent", () => {
    expect(createAgentConfig({ provider: "ollama" }).provider).toBe("ollama")
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

  test("explicit pin wins per axis (lying pty: reported wider than visible)", () => {
    // Termius case: the pty claims 120 while the window shows ~100 — every
    // full-width row wraps terminal-side and repaints stack clones. The pin
    // is the visible width, so the frame fits again.
    const sys = { getWindowSize: () => [120, 30] }
    expect(readLiveWindowSize(sys, { NEMO_COLUMNS: "100" })).toEqual({ columns: 100, rows: 30 })
    expect(readLiveWindowSize(sys, { NEMO_ROWS: "24" })).toEqual({ columns: 120, rows: 24 })
    expect(readLiveWindowSize(sys, { NEMO_COLUMNS: "100", NEMO_ROWS: "24" })).toEqual({
      columns: 100,
      rows: 24,
    })
  })

  test("malformed or sub-floor pins are ignored, never applied", () => {
    const sys = { getWindowSize: () => [120, 30] }
    for (const env of [
      { NEMO_COLUMNS: "wide" },
      { NEMO_COLUMNS: "" },
      { NEMO_COLUMNS: "10" },
      { NEMO_ROWS: "-5" },
      { NEMO_COLUMNS: "10", NEMO_ROWS: "5" },
    ]) {
      expect(readLiveWindowSize(sys, env)).toEqual({ columns: 120, rows: 30 })
    }
  })

  test("pinned axes survive a throwing syscall; one axis is never invented", () => {
    const throwing = {
      getWindowSize: () => {
        throw new Error("weird pty")
      },
    }
    expect(readLiveWindowSize(throwing, { NEMO_COLUMNS: "100", NEMO_ROWS: "24" })).toEqual({
      columns: 100,
      rows: 24,
    })
    expect(readLiveWindowSize(throwing, { NEMO_COLUMNS: "100" })).toBeNull()
    expect(readLiveWindowSize(throwing, {})).toBeNull()
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

  test("applies the explicit pin to the cache (Ink layouts follow it too)", () => {
    // The whole point of syncing through the shared cache: Ink's Yoga
    // widths, wrap, and erase math all read stdout.columns — one assignment
    // steers every layer, app and framework alike.
    const stdout = { columns: 120, rows: 30, getWindowSize: () => [120, 30] }
    expect(syncWindowSizeCache(stdout, { NEMO_COLUMNS: "100" })).toBe(true)
    expect(stdout.columns).toBe(100)
    expect(stdout.rows).toBe(30)
    expect(syncWindowSizeCache(stdout, { NEMO_COLUMNS: "100" })).toBe(false)
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
    ] as NemoMessage[])
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
    ] as NemoMessage[])
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
    ] as NemoMessage[])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "tool_use" })
  })

  test("malformed / non-object tool args degrade to { value } instead of throwing", () => {
    const malformed = convertToAgentMessages([
      { role: "assistant", content: "not json {", toolCallId: "c", toolName: "t" },
    ] as NemoMessage[])
    const call = malformed[0]?.content
    expect(Array.isArray(call) && call[0] && typeof call[0] === "object" && "arguments" in call[0]).toBe(true)
    expect(Array.isArray(call) ? (call[0] as { arguments: unknown }).arguments : null).toEqual({
      value: "not json {",
    })

    const nonObject = convertToAgentMessages([
      { role: "assistant", content: "[1,2]", toolCallId: "c", toolName: "t" },
    ] as NemoMessage[])
    const call2 = nonObject[0]?.content
    expect(Array.isArray(call2) ? (call2[0] as { arguments: unknown }).arguments : null).toEqual({
      value: [1, 2],
    })
  })

  test("thinking rides along ahead of the text part", () => {
    const out = convertToAgentMessages([
      { role: "assistant", content: "answer", thinking: "hmm…" },
    ] as NemoMessage[])
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
    ] as NemoMessage[])
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
  test("default OFF: no flag, no env — inline (the transcript IS the scrollback) is the default path", () => {
    expect(resolveAltScreen({})).toBe(false);
    expect(resolveAltScreen({ env: {} })).toBe(false);
  });

  test("an explicitly set env var decides by truthiness — empty counts as opt-out", () => {
    expect(resolveAltScreen({ env: { NEMO_ALT_SCREEN: "" } })).toBe(false);
    for (const v of ["1", "true", "TRUE", "yes", "on", " Y "]) {
      expect(resolveAltScreen({ env: { NEMO_ALT_SCREEN: v } }), v).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "maybe"]) {
      expect(resolveAltScreen({ env: { NEMO_ALT_SCREEN: v } }), v).toBe(false);
    }
  });

  test("explicit CLI flag wins over env either way", () => {
    expect(resolveAltScreen({ flag: true, env: { NEMO_ALT_SCREEN: "0" } })).toBe(true);
    expect(resolveAltScreen({ flag: false, env: { NEMO_ALT_SCREEN: "1" } })).toBe(false);
    expect(resolveAltScreen({ flag: "true", env: {} })).toBe(true);
    expect(resolveAltScreen({ flag: "false", env: { NEMO_ALT_SCREEN: "1" } })).toBe(false);
  });
});

describe("alt-screen sequences", () => {
  test("enter switches to the alternate buffer and nothing else", () => {
    const written: string[] = [];
    enterAltScreen((chunk) => written.push(chunk));
    expect(written).toEqual(["\x1b[?1049h"]);
    expect(ALT_SCREEN_ENTER).toBe("\x1b[?1049h");
  });

  test("leave restores the main buffer AND the caret", () => {
    // The app hides the hardware caret for its lifetime and process.exit
    // skips React's unmount cleanup, so leaving without ?25h would hand the
    // shell back caret-less after every alt-screen session.
    const written: string[] = [];
    leaveAltScreen((chunk) => written.push(chunk));
    expect(written).toEqual(["\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1006l"]);
    expect(ALT_SCREEN_LEAVE).toBe("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1006l");
  });
});

describe("settle reprint slot", () => {
  test("single owner: register invokes, replace swaps, unregister silences", async () => {
    const { registerSettleReprintHandler, requestSettleReprint } = await import("./app-bootstrap.js");
    const seen: string[] = [];
    registerSettleReprintHandler(() => seen.push("a"));
    requestSettleReprint();
    registerSettleReprintHandler(() => seen.push("b"));
    requestSettleReprint();
    registerSettleReprintHandler(undefined);
    requestSettleReprint();
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("turn-end fullRender slot", () => {
  test("reports whether a wipe happened: false with no guard, true + called when registered", async () => {
    const { registerFullRenderHandler, requestFullRender } = await import("./app-bootstrap.js");
    registerFullRenderHandler(undefined);
    expect(requestFullRender()).toBe(false);
    let calls = 0;
    registerFullRenderHandler(() => {
      calls += 1;
      return true;
    });
    expect(requestFullRender()).toBe(true);
    expect(calls).toBe(1);
    registerFullRenderHandler(undefined);
    expect(requestFullRender()).toBe(false);
    expect(calls).toBe(1);
  });

  test("a refusing guard propagates false (App must not remount without a wipe)", async () => {
    const { registerFullRenderHandler, requestFullRender } = await import("./app-bootstrap.js");
    registerFullRenderHandler(() => false);
    expect(requestFullRender()).toBe(false);
    registerFullRenderHandler(undefined);
  });
});

// Parked until the feature lands: turn-finalize.ts and use-parked-window.ts
// are not in the tree yet, so these pins can only ever fail.
describe.skip("turn-end fullRender wiring (source pins the contract)", () => {
  // Same reason as the scroll wiring above: App.tsx is too heavy to import,
  // so the growth latch (arm while streaming, consume once at turn end) and
  // the guard registration are pinned textually. What matters: ONLY a grown
  // turn wipes (quiet turns stay put), and the wipe+reprint pair lives in
  // the guard next to the settle path — never a remount without a wipe.
  const appSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), "packages", "tui", "src", "ink-app", "App.tsx"), "utf8");
  const guardSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), "packages", "tui", "src", "ink-app", "resize-guard.ts"), "utf8");
  const latchSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), "packages", "tui", "src", "ink-app", "turn-finalize.ts"), "utf8");

  test("App arms growth on every row path and finishes once per turn", () => {
    const src = appSource();
    expect(src).toContain("createTurnFinalize");
    expect(src).toContain("turnGrowthRef.current.markGrewIfRunning(isRunningRef.current)");
    expect(src.match(/turnGrowthRef\.current\.markGrew\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("turnGrowthRef.current.reset()");
    expect(src).toContain("turnGrowthRef.current.finishTurn()");
  });

  test("the latch pairs wipe+reprint and never remounts without a wipe", () => {
    const src = latchSource();
    expect(src).toContain("requestFullRender()");
    expect(src).toContain("if (!grew) return false");
  });

  test("the guard owns the wipe+reprint pair behind the slot", () => {
    const src = guardSource();
    expect(src).toContain("registerFullRenderHandler(");
    expect(src).toContain("requestSettleReprint()");
  });
});

describe.skip("App alt-screen scroll wiring (source pins the contract)", () => {
  // App.tsx is too heavy to import (full agent loop), so these pin the
  // wiring textually — the same pattern ink-repl-startup-clear uses for the
  // entrypoint. What matters: every scroll path below is gated on altScreen,
  // so inline mode keeps native scroll byte-identical to before. The parked
  // window itself lives in use-parked-window.ts (4000-line cap) and is
  // behavior-tested there; here only the App-side plugs are pinned.
  const appSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), "packages", "tui", "src", "ink-app", "App.tsx"), "utf8");

  test("parked window comes from the hook, end index feeds the frame", () => {
    const src = appSource();
    expect(src).toContain("const parked = useParkedWindow(messages.length, altScreen, stdout)");
    expect(src).toContain("const endIdx = parked.endIdx");
    expect(src).toContain("endIdx={endIdx}");
  });

  test("keys, snap and chip go through the hook (no inline scroll paths)", () => {
    const src = appSource();
    expect(src).toContain("onHistoryScroll={parked.onHistoryScroll}");
    expect(src).toContain("if (altScreen) parked.snapToLive()");
    expect(src).toContain("onScrollDepth={setFrameStartIdx}");
    expect(src).toContain("parked.hiddenBelow");
  });

  test("footer chip shows parked distance only in alt-screen mode", () => {
    const src = appSource();
    expect(src).toContain("scrollDepth:");
  });
});

describe("agentMessagesToRows (transcript → live rows)", () => {
  const callThenResult = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Working on it." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      stopReason: "tool_use",
    },
    {
      role: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "file.txt" }],
      isError: false,
    },
  ] as never

  test("folds each tool result back into its own call row", () => {
    // A transcript stores the prose and the call in ONE assistant message plus
    // a separate tool row. Rendered raw, that showed the args JSON as assistant
    // prose and the result nowhere.
    const rows = agentMessagesToRows(callThenResult)
    expect(rows.map((r) => r.role)).toEqual(["assistant", "assistant"])
    const call = rows[1]!
    expect(call.toolCallId).toBe("call_1")
    expect(call.toolName).toBe("bash")
    expect(JSON.parse(call.content)).toEqual({ command: "ls" })
    expect(call.result).toBe("file.txt")
    expect(call.toolStatus).toBe("completed")
    expect(rows[0]!.content).toBe("Working on it.")
  })

  test("settles a call whose result never landed", () => {
    const rows = agentMessagesToRows([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "read", arguments: {} }],
        stopReason: "tool_use",
      },
    ] as never)
    expect(rows[0]!.toolStatus).toBe("completed")
  })

  test("keeps an orphan tool result as its own row and drops system rows", () => {
    const rows = agentMessagesToRows([
      { role: "system", content: "prompt" },
      {
        role: "tool",
        toolCallId: "call_missing",
        toolName: "bash",
        content: [{ type: "text", text: "orphan" }],
        isError: true,
      },
    ] as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe("tool")
    expect(rows[0]!.toolStatus).toBe("error")
  })

  test("round-trips so the agent keeps the tool result", () => {
    // The resumed agent must receive toolCall + tool result, not the args JSON
    // as prose — that is what convertToAgentMessages rebuilds from live rows.
    const rows = agentMessagesToRows(callThenResult)
    const agentMessages = convertToAgentMessages(rows)
    const toolMsg = agentMessages.find((m) => m.role === "tool") as { content: Array<{ text: string }> } | undefined
    expect(toolMsg?.content[0]?.text).toBe("file.txt")
    const callMsg = agentMessages.find(
      (m) => m.role === "assistant" && (m as { content: Array<{ type: string }> }).content.some((p) => p.type === "toolCall"),
    ) as { content: Array<{ type: string; arguments?: Record<string, unknown> }> } | undefined
    expect(callMsg?.content.some((p) => p.type === "toolCall" && p.arguments?.command === "ls")).toBe(true)
    expect(rows.some((r) => r.content === "Working on it.")).toBe(true)
  })
})

describe("resumeQuery", () => {
  const row = (content: string): NemoMessage =>
    ({ id: content, timestamp: 0, role: "user", content }) as NemoMessage

  test("ranks memory against the tail, not the head", () => {
    // The topic of a long chat is at the end; the first turns are old news, so
    // the whole transcript diluted what memory the resumed session got.
    const msgs = [row("setup the repo"), row("fix the parser"), ...Array.from({ length: 10 }, (_, i) => row(`turn ${i}`)), row("deploy to ap-south-1")]
    const q = resumeQuery(msgs)
    expect(q).toContain("deploy to ap-south-1")
    expect(q).not.toContain("setup the repo")
  })

  test("collapses whitespace and caps the length", () => {
    expect(resumeQuery([row("a\n\n  b\t\tc")])).toBe("a b c")
    expect(resumeQuery([row("x".repeat(5000))]).length).toBeLessThanOrEqual(200)
    expect(resumeQuery(Array.from({ length: 20 }, () => row("y".repeat(300)))).length).toBeLessThanOrEqual(600)
  })
})

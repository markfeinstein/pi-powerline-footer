import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import { NERD_ICONS, setNerdFontsPreference } from "../icons.ts";
import { rainbow } from "../theme.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

function hexAnsi(hex: `#${string}`): string {
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function createSegmentContext(thinkingLevel: string, colors: ColorScheme): SegmentContext {
  return {
    model: undefined,
    thinkingLevel,
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme: {
      fg() {
        throw new Error("unexpected theme color lookup in thinking segment test");
      },
    } satisfies ThemeLike,
    colors,
  };
}

test("thinking segment uses per-level colors for off through medium", () => {
  const colors: ColorScheme = {
    thinking: "#111111",
    thinkingMinimal: "#222222",
    thinkingLow: "#333333",
    thinkingMedium: "#444444",
  };

  const off = renderSegment("thinking", createSegmentContext("off", colors));
  const minimal = renderSegment("thinking", createSegmentContext("minimal", colors));
  const low = renderSegment("thinking", createSegmentContext("low", colors));
  const medium = renderSegment("thinking", createSegmentContext("medium", colors));

  assert.equal(off.content, `${hexAnsi("#111111")}🧠 off\x1b[0m`);
  assert.equal(minimal.content, `${hexAnsi("#222222")}🧠 min\x1b[0m`);
  assert.equal(low.content, `${hexAnsi("#333333")}🧠 low\x1b[0m`);
  assert.equal(medium.content, `${hexAnsi("#444444")}🧠 med\x1b[0m`);
});

test("thinking segment uses the monochrome Nerd Font brain when enabled", () => {
  try {
    setNerdFontsPreference(true);
    const rendered = renderSegment("thinking", createSegmentContext("medium", { thinkingMedium: "#444444" }));
    assert.equal(rendered.content, `${hexAnsi("#444444")}${NERD_ICONS.thinking} med\x1b[0m`);
  } finally {
    setNerdFontsPreference(null);
  }
});

test("thinking segment uses rainbow styling for high through max by default", () => {
  const colors: ColorScheme = { thinking: "#111111" };

  for (const level of ["high", "xhigh", "max"]) {
    const rendered = renderSegment("thinking", createSegmentContext(level, colors));
    assert.deepEqual(rendered, {
      content: rainbow(`🧠 ${level}`),
      visible: true,
    });
  }
});

test("thinking segment honors per-level colors for high through max", () => {
  const colors: ColorScheme = {
    thinkingHigh: "#111111",
    thinkingXhigh: "#222222",
    thinkingMax: "#333333",
  };

  const high = renderSegment("thinking", createSegmentContext("high", colors));
  const xhigh = renderSegment("thinking", createSegmentContext("xhigh", colors));
  const max = renderSegment("thinking", createSegmentContext("max", colors));

  assert.equal(high.content, `${hexAnsi("#111111")}🧠 high\x1b[0m`);
  assert.equal(xhigh.content, `${hexAnsi("#222222")}🧠 xhigh\x1b[0m`);
  assert.equal(max.content, `${hexAnsi("#333333")}🧠 max\x1b[0m`);
});

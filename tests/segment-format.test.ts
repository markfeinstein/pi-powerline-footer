import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

function hexAnsi(hex: `#${string}`): string {
  const value = hex.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function ctx(overrides: Partial<SegmentContext>): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: false,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
    alwaysShowTokens: false,
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
        throw new Error("unexpected theme color name lookup; tests use hex colors");
      },
    } satisfies ThemeLike,
    colors: {} as ColorScheme,
    ...overrides,
  };
}

// ── formatTokens branches (via token_total) ──────────────────────────────────
const TOKEN_CASES: Array<[number, string]> = [
  [500, "500"],
  [999, "999"],
  [1500, "1.5k"],
  [12000, "12k"],
  [999999, "1.0M"],
  [1_500_000, "1.5M"],
  [9_999_999, "10M"],
  [12_000_000, "12M"],
];

for (const [input, expected] of TOKEN_CASES) {
  test(`token_total formats ${input} as ${expected}`, () => {
    const rendered = renderSegment(
      "token_total",
      ctx({
        usageStats: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        colors: { tokens: "#0a0a0a" } as ColorScheme,
      }),
    );
    assert.equal(rendered.visible, true);
    assert.ok(
      rendered.content.includes(expected),
      `expected ${expected} in ${JSON.stringify(rendered.content)}`,
    );
  });
}

test("token_total is hidden when there are no tokens", () => {
  assert.equal(renderSegment("token_total", ctx({})).visible, false);
});

test("cost segment renders subscription without throwing", () => {
  const rendered = renderSegment(
    "cost",
    ctx({
      usingSubscription: true,
      colors: { cost: "#101010" } as ColorScheme,
    }),
  );

  assert.equal(rendered.visible, true);
  assert.ok(rendered.content.length > 0);
});

test("path segment strips terminal controls from cwd text", () => {
  const rendered = renderSegment(
    "path",
    ctx({
      cwd: "/tmp/repo\x1b]52;c;secret\x07\x1b[31mred",
      options: { path: { mode: "full" } },
      colors: { path: "#101010" } as ColorScheme,
    }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /red/);
});

test("shell mode segment strips terminal controls from shell fields", () => {
  const rendered = renderSegment(
    "shell_mode",
    ctx({
      shellModeActive: true,
      shellName: "bash\x1b]0;secret\x07",
      shellCwd: "/tmp/project\x1b[31mred",
      colors: { shellMode: "#101010" } as ColorScheme,
    }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /projectred/);
});

// ── context_pct threshold colors ─────────────────────────────────────────────
const CONTEXT_COLORS: ColorScheme = {
  context: "#101010",
  contextWarn: "#202020",
  contextError: "#303030",
} as ColorScheme;

const THRESHOLD_CASES: Array<[number, `#${string}`, string]> = [
  [50, "#101010", "50%/8.0k"],
  [70, "#101010", "70%/8.0k"], // boundary: not > 70 -> base color
  [70.1, "#202020", "70%/8.0k"],
  [90, "#202020", "90%/8.0k"], // boundary: not > 90 -> warn color
  [90.6, "#303030", "91%/8.0k"],
];

for (const [pct, hex, display] of THRESHOLD_CASES) {
  test(`context_pct at ${pct}% uses ${hex}`, () => {
    const rendered = renderSegment(
      "context_pct",
      ctx({ contextPercent: pct, contextWindow: 8000, colors: CONTEXT_COLORS }),
    );
    assert.equal(rendered.visible, true);
    assert.ok(
      rendered.content.includes(hexAnsi(hex)),
      `expected color ${hex} at ${pct}% in ${JSON.stringify(rendered.content)}`,
    );
    assert.ok(rendered.content.includes(display));
  });
}

test("context_pct is hidden when custom compaction is enabled", () => {
  const rendered = renderSegment(
    "context_pct",
    ctx({ contextPercent: 42, contextWindow: 8000, customCompactionEnabled: true }),
  );
  assert.equal(rendered.visible, false);
});

test("context_pct is hidden when context window is unavailable", () => {
  const rendered = renderSegment(
    "context_pct",
    ctx({ contextPercent: 0, contextWindow: 0 }),
  );
  assert.equal(rendered.visible, false);
});

// ── formatDuration branches (via time_spent) ─────────────────────────────────
test("time_spent is hidden below one second", () => {
  const rendered = renderSegment("time_spent", ctx({ sessionStartTime: Date.now() - 500 }));
  assert.equal(rendered.visible, false);
});

const DURATION_CASES: Array<[number, string]> = [
  [5_200, "5s"],
  [65_200, "1m5s"],
  [3_725_200, "1h2m"],
];

for (const [elapsedMs, expected] of DURATION_CASES) {
  test(`time_spent formats ~${elapsedMs}ms as ${expected}`, () => {
    const rendered = renderSegment("time_spent", ctx({ sessionStartTime: Date.now() - elapsedMs }));
    assert.equal(rendered.visible, true);
    assert.ok(
      rendered.content.includes(expected),
      `expected ${expected} in ${JSON.stringify(rendered.content)}`,
    );
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";
import { getIcons } from "../icons.ts";
import type { ColorScheme, SegmentContext, ThemeLike } from "../types.ts";

const PRESETS = ["default", "full", "custom"] as const;

function ctx(overrides: Partial<SegmentContext>): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: true,
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
    theme: { fg: (_c, t) => t } satisfies ThemeLike,
    colors: {} as ColorScheme,
    ...overrides,
  };
}

for (const id of ["token_in", "token_out", "cache_read", "cache_write"] as const) {
  test(`${id} is hidden at 0 by default`, () => {
    assert.equal(renderSegment(id, ctx({ alwaysShowTokens: false })).visible, false);
  });

  test(`${id} renders "0" when alwaysShowTokens is set`, () => {
    const rendered = renderSegment(id, ctx({ alwaysShowTokens: true }));
    assert.equal(rendered.visible, true);
    assert.ok(rendered.content.includes("0"), `expected a 0 in ${JSON.stringify(rendered.content)}`);
  });
}

test("token segments still show real values when present", () => {
  const rendered = renderSegment("token_in", ctx({ usageStats: { input: 1500, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }));
  assert.equal(rendered.visible, true);
  assert.ok(rendered.content.includes("1.5k"));
});

test("cache read token uses one cache icon without the input icon", () => {
  const icons = getIcons();
  const rendered = renderSegment("cache_read", ctx({ usageStats: { input: 0, output: 0, cacheRead: 42, cacheWrite: 0, cost: 0 } }));
  assert.equal(rendered.visible, true);
  assert.ok(rendered.content.includes(icons.cache));
  assert.ok(!rendered.content.includes(icons.input));
});

test("parsePowerlineConfig reads alwaysShowTokens", () => {
  assert.equal(parsePowerlineConfig({ alwaysShowTokens: true }, PRESETS).alwaysShowTokens, true);
  assert.equal(parsePowerlineConfig({}, PRESETS).alwaysShowTokens, false);
});

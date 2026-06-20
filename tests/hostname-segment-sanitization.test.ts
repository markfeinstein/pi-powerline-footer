import test, { mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import type { SegmentContext, ThemeLike } from "../types.ts";

function ctx(overrides: Partial<SegmentContext> = {}): SegmentContext {
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
      fg(_color: string, text: string) {
        return text;
      },
    } satisfies ThemeLike,
    colors: {},
    ...overrides,
  };
}

test("hostname segment strips terminal controls", async () => {
  const hostnameMock = mock.method(os, "hostname", () => "host\x1b]52;c;secret\x07\x1b[31m.local");
  syncBuiltinESMExports();

  try {
    const { renderSegment } = await import(`../segments.ts?hostname-test=${Date.now()}-${Math.random()}`);
    const rendered = renderSegment("hostname", ctx());

    assert.equal(rendered.visible, true);
    assert.doesNotMatch(rendered.content, /\x1b\]/);
    assert.doesNotMatch(rendered.content, /\x1b\[31m/);
    assert.doesNotMatch(rendered.content, /secret/);
    assert.match(rendered.content, /host/);
  } finally {
    hostnameMock.mock.restore();
    syncBuiltinESMExports();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import type { SegmentContext, ThemeLike } from "../types.ts";

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
      fg(_color: string, text: string) {
        return text;
      },
    } satisfies ThemeLike,
    colors: {},
    ...overrides,
  };
}

test("model segment strips terminal controls from provider names", () => {
  const rendered = renderSegment(
    "model",
    ctx({ model: { id: "provider/model", name: "\x1b]52;c;secret\x07Claude Bad\x1b[31m", reasoning: false } }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /Bad/);
});

test("git segment strips terminal controls from provider branch names", () => {
  const rendered = renderSegment(
    "git",
    ctx({ git: { branch: "main\x1b]52;c;secret\x07\x1b[31m", staged: 0, unstaged: 0, untracked: 0 } }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /main/);
});

test("path segment strips terminal controls from cwd text", () => {
  const rendered = renderSegment(
    "path",
    ctx({ cwd: "/tmp/project\x1b]52;c;secret\x07\x1b[31mred", options: { path: { mode: "full" } } }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /projectred/);
});

test("path basename sanitizes controls before extracting the display name", () => {
  const rendered = renderSegment(
    "path",
    ctx({ cwd: "/tmp/project\x1b]52;c;/secret\x07red", options: { path: { mode: "basename" } } }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /projectred/);
});

test("shell mode segment strips terminal controls from shell fields", () => {
  const rendered = renderSegment(
    "shell_mode",
    ctx({
      shellModeActive: true,
      shellName: "bash\x1b]0;secret\x07",
      shellCwd: "/tmp/project\x1b[31mred",
    }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /projectred/);
});

test("shell mode sanitizes cwd before extracting the display name", () => {
  const rendered = renderSegment(
    "shell_mode",
    ctx({
      shellModeActive: true,
      shellCwd: "/tmp/project\x1b]52;c;/secret\x07red",
    }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /projectred/);
});

test("thinking segment strips terminal controls from event values", () => {
  const rendered = renderSegment(
    "thinking",
    ctx({ thinkingLevel: "high\x1b]52;c;secret\x07\x1b[31mred" }),
  );

  assert.equal(rendered.visible, true);
  assert.doesNotMatch(rendered.content, /\x1b\]/);
  assert.doesNotMatch(rendered.content, /\x1b\[31m/);
  assert.doesNotMatch(rendered.content, /secret/);
  assert.match(rendered.content, /highred/);
});

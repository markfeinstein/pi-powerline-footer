import test from "node:test";
import assert from "node:assert/strict";
import { reserveSpinnerSlot, keepSpinnerGlyph } from "../fixed-editor/cluster.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";
import powerlineFooter, { computeResponsiveLayout } from "../index.ts";
import { getPreset } from "../presets.ts";
import type { SegmentContext } from "../types.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRESETS = ["default", "full", "custom"] as const;

test("reserves a spinner slot and shows the glyph when working", () => {
  const out = reserveSpinnerSlot(" m5 > model ", "⠋");
  assert.equal(out, " ⠋\x1b[0m m5 > model ");
});

test("reserves the same-width slot (blank) when idle", () => {
  const working = reserveSpinnerSlot(" m5 > model ", "⠋");
  const idle = reserveSpinnerSlot(" m5 > model ", "");
  // bar text starts at the same column whether or not the spinner shows
  assert.equal(visibleWidth(working), visibleWidth(idle));
  assert.equal(idle, "   m5 > model ");
});

test("reserveSpinnerSlot trims full status lines down to the spinner glyph", () => {
  const out = reserveSpinnerSlot(" m5 > model ", "⠋ Working…");
  assert.equal(out, " ⠋\x1b[0m m5 > model ");
});

test("reserve slot preserves ANSI on the glyph", () => {
  const out = reserveSpinnerSlot(" bar ", "\x1b[33m⠙\x1b[0m");
  assert.ok(out.startsWith(" \x1b[33m⠙\x1b[0m\x1b[0m "));
});

test("reserveSpinnerSlot preserves right-alignment padding for empty-left bars", () => {
  // A right-aligned bar (empty left group) begins with alignment padding. The
  // slot must consume only one leading space so the right content stays flush
  // with the terminal edge instead of collapsing against the spinner.
  const width = 30;
  const right = " RIGHT ";
  const padded = `${" ".repeat(width - visibleWidth(right))}${right}`;
  assert.equal(visibleWidth(padded), width);

  const out = reserveSpinnerSlot(padded, "⠋");
  // Net +2 columns (SPINNER_SLOT_RESERVE), not a collapse down to the glyph width.
  assert.equal(visibleWidth(out), width + 2);
  // The right content remains flush at the right edge.
  assert.ok(out.endsWith("RIGHT "), `right content not flush: ${JSON.stringify(out)}`);
  assert.ok(out.startsWith(" ⠋\x1b[0m  "), `spinner slot missing leading padding: ${JSON.stringify(out)}`);
});

test("parsePowerlineConfig reads inlineWorkingStatus", () => {
  assert.equal(parsePowerlineConfig({ inlineWorkingStatus: true }, PRESETS).inlineWorkingStatus, true);
  assert.equal(parsePowerlineConfig({}, PRESETS).inlineWorkingStatus, false);
});

test("parsePowerlineConfig reads hideWorkingMessage", () => {
  assert.equal(parsePowerlineConfig({ hideWorkingMessage: true }, PRESETS).hideWorkingMessage, true);
  assert.equal(parsePowerlineConfig({}, PRESETS).hideWorkingMessage, false);
});

test("keepSpinnerGlyph keeps only the leading glyph", () => {
  assert.equal(keepSpinnerGlyph("⠋ Working..."), "⠋\x1b[0m");
  assert.equal(keepSpinnerGlyph("⠋ Engaging warp drive..."), "⠋\x1b[0m");
});

test("keepSpinnerGlyph preserves ANSI styling around the glyph", () => {
  const out = keepSpinnerGlyph("\x1b[33m⠙\x1b[0m Working…");
  assert.ok(out.startsWith("\x1b[33m⠙"), `glyph + color preserved, got ${JSON.stringify(out)}`);
  assert.equal(visibleWidth(out), 1, "only the 1-col spinner is visible");
});

test("keepSpinnerGlyph returns empty for blank input", () => {
  assert.equal(keepSpinnerGlyph("   "), "");
  assert.equal(keepSpinnerGlyph("\x1b[0m"), "");
});

test("inline working status reserves width for no-right-segment presets", () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "powerline-inline-home-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ powerline: { inlineWorkingStatus: true } }) + "\n");
  process.env.HOME = home;

  try {
    powerlineFooter({ on() {}, registerCommand() {}, registerShortcut() {} } as never);
    const segmentCtx: SegmentContext = {
      model: { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true, contextWindow: 200000 },
      thinkingLevel: "medium",
      sessionId: "session-1234567890",
      cwd: "/workspace/project",
      usageStats: { input: 12000, output: 3400, cacheRead: 5600, cacheWrite: 0, cost: 1.23 },
      contextPercent: 42,
      contextWindow: 200000,
      autoCompactEnabled: true,
      customCompactionEnabled: false,
      usingSubscription: false,
      sessionStartTime: Date.now() - 5000,
      alwaysShowTokens: false,
      shellModeActive: false,
      shellRunning: false,
      shellName: null,
      shellCwd: null,
      git: { branch: "main", staged: 1, unstaged: 1, untracked: 1 },
      extensionStatuses: new Map(),
      hiddenExtensionStatusKeys: new Set(),
      customItemsById: new Map(),
      options: getPreset("default").segmentOptions ?? {},
      theme: { fg: (_color: string, text: string) => text },
      colors: getPreset("default").colors ?? {},
    };

    for (let width = 24; width <= 100; width++) {
      const layout = computeResponsiveLayout(segmentCtx, getPreset("default"), width);
      if (!layout.topContent) continue;
      assert.ok(
        visibleWidth(reserveSpinnerSlot(layout.topContent, "⠋")) <= width,
        `inline status line exceeded width ${width}: ${JSON.stringify(layout.topContent)}`,
      );
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

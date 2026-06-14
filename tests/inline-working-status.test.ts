import test from "node:test";
import assert from "node:assert/strict";
import { reserveSpinnerSlot, keepSpinnerGlyph } from "../fixed-editor/cluster.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

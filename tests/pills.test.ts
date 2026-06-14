import test from "node:test";
import assert from "node:assert/strict";
import { wrapInPill, wrapInPillGroup, buildPillUnits, PILL_LEFT_CAP, PILL_RIGHT_CAP, DEFAULT_PILL_BACKGROUND } from "../pills.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const PRESETS = ["default", "full", "custom"] as const;
const reset = "\x1b[0m";

test("wrapInPill adds both rounded caps and a background fill", () => {
  const pill = wrapInPill("\x1b[38;2;1;2;3mmodel\x1b[0m", "#3b4252");
  assert.ok(pill.startsWith(PILL_LEFT_CAP) === false, "left cap is preceded by its color code");
  assert.ok(pill.includes(PILL_LEFT_CAP), "has left cap");
  assert.ok(pill.includes(PILL_RIGHT_CAP), "has right cap");
  // 0x3b,0x42,0x52 => 59;66;82 background
  assert.ok(pill.includes("\x1b[48;2;59;66;82m"), "has bg fill");
  assert.ok(pill.includes("model"), "keeps content");
});

test("pill visible width is content + 2 caps + trailing spacer", () => {
  const content = "\x1b[38;2;1;2;3mmodel\x1b[0m";
  const pill = wrapInPill(content, "#3b4252");
  const capW = visibleWidth(PILL_LEFT_CAP) + visibleWidth(PILL_RIGHT_CAP);
  assert.equal(visibleWidth(pill), visibleWidth(content) + capW + 1);
});

test("icon-only pills omit leading padding but keep trailing spacer", () => {
  const pill = wrapInPill("x", "#3b4252");
  const capW = visibleWidth(PILL_LEFT_CAP) + visibleWidth(PILL_RIGHT_CAP);
  assert.equal(visibleWidth(pill), 1 + capW + 1);
  assert.ok(!pill.includes(`${PILL_LEFT_CAP}${reset}\x1b[48;2;59;66;82m `));
  assert.ok(pill.includes(`x ${reset}\x1b[38;2;59;66;82m${PILL_RIGHT_CAP}`));
});

test("internal resets re-assert the background so multi-color segments stay filled", () => {
  const content = `\x1b[38;2;1;1;1mA${reset}\x1b[38;2;2;2;2mB${reset}`;
  const pill = wrapInPill(content, "#000000");
  // every reset inside the body is followed by a re-assert of the bg
  const matches = pill.split(`${reset}\x1b[48;2;0;0;0m`).length - 1;
  assert.ok(matches >= 2, `expected bg re-asserted after inner resets, got ${matches}`);
});

test("parsePowerlineConfig reads pills + pillBackground", () => {
  assert.equal(parsePowerlineConfig({ pills: true }, PRESETS).pills, true);
  assert.equal(parsePowerlineConfig({}, PRESETS).pills, false);
  assert.equal(parsePowerlineConfig({ pillBackground: "#1a2b3c" }, PRESETS).pillBackground, "#1a2b3c");
});

test("invalid pillBackground falls back to the default", () => {
  assert.equal(parsePowerlineConfig({ pillBackground: "red" }, PRESETS).pillBackground, DEFAULT_PILL_BACKGROUND);
  assert.equal(parsePowerlineConfig({}, PRESETS).pillBackground, DEFAULT_PILL_BACKGROUND);
});

test("wrapInPillGroup renders one pill with two different backgrounds", () => {
  const pill = wrapInPillGroup([
    { content: "dir", bg: "#010203" },
    { content: "git", bg: "#0a0b0c", leadingSpace: true, trailingSpace: false },
  ]);
  // single pair of outer caps
  assert.equal(pill.split(PILL_LEFT_CAP).length - 1, 1, "one left cap");
  assert.equal(pill.split(PILL_RIGHT_CAP).length - 1, 1, "one right cap");
  // both backgrounds present
  assert.ok(pill.includes("\x1b[48;2;1;2;3m"), "first bg");
  assert.ok(pill.includes("\x1b[48;2;10;11;12m"), "second bg");
  assert.ok(pill.includes("dir") && pill.includes("git"));
  assert.ok(pill.includes("m git"), "continuation segment has leading space");
  assert.ok(!pill.includes(`git ${reset}`), "git segment has no trailing space");
});

test("buildPillUnits merges adjacent same-group segments and isolates others", () => {
  const parts = [
    { id: "path", content: "~/dev" },
    { id: "git", content: "main" },
    { id: "model", content: "gpt" },
    { id: "thinking", content: "med" },
    { id: "time_spent", content: "3s" },
  ];
  const groups = [["path", "git"], ["model", "thinking"]];
  const colors = { path: "#111111", git: "#222222", model: "#333333", thinking: "#444444" };
  const units = buildPillUnits(parts, groups, colors, "#999999");
  assert.equal(units.length, 3, "3 pills: [path,git], [model,thinking], [time_spent]");
  assert.deepEqual(units[0].map((s) => s.bg), ["#111111", "#222222"]);
  assert.deepEqual(units[1].map((s) => s.bg), ["#333333", "#444444"]);
  assert.deepEqual(units[2].map((s) => s.bg), ["#999999"]);
  assert.equal(units[0][1]?.leadingSpace, true, "git gets leading space in grouped pill");
  assert.equal(units[0][1]?.trailingSpace, false, "git omits trailing space");
  assert.equal(units[1][1]?.leadingSpace, true, "thinking gets leading space in grouped pill");
  assert.equal(units[1][1]?.trailingSpace, false, "thinking omits trailing space");
});

test("buildPillUnits disables trailing space for token and cache pills", () => {
  const units = buildPillUnits([
    { id: "token_in", content: "in" },
    { id: "token_out", content: "out" },
    { id: "cache_read", content: "cache" },
    { id: "cache_write", content: "write" },
  ], [], {}, "#000000");

  assert.deepEqual(units.map((u) => u[0]?.trailingSpace), [false, false, false, false]);
});

test("buildPillUnits does not merge same-group segments that aren't adjacent", () => {
  const parts = [
    { id: "path", content: "~/dev" },
    { id: "model", content: "gpt" },
    { id: "git", content: "main" },
  ];
  const units = buildPillUnits(parts, [["path", "git"]], {}, "#000000");
  assert.equal(units.length, 3, "path and git split by model -> 3 separate pills");
});

test("wrapInPillGroup recolors text/icons when fg is set and strips old colors", () => {
  const colored = "\x1b[38;2;9;9;9m\uF115 ~/dev\x1b[0m";
  const pill = wrapInPillGroup([{ content: colored, bg: "#000000", fg: "#abcdef" }]);
  // old segment color removed, new fg applied (0xab,0xcd,0xef => 171;205;239)
  assert.ok(!pill.includes("38;2;9;9;9m"), "old fg stripped");
  assert.ok(pill.includes("\x1b[38;2;171;205;239m"), "new fg applied");
  assert.ok(pill.includes("~/dev"), "text kept");
});

test("buildPillUnits assigns fg from fgColors then defaultFg", () => {
  const parts = [{ id: "path", content: "a" }, { id: "git", content: "b" }];
  const units = buildPillUnits(parts, [["path", "git"]], {}, "#000000", { path: "#111111" }, "#eeeeee");
  assert.equal(units[0][0].fg, "#111111", "per-segment fg wins");
  assert.equal(units[0][1].fg, "#eeeeee", "falls back to defaultFg");
});

test("parsePowerlineConfig reads pillForeground + pillTextColors", () => {
  const cfg = parsePowerlineConfig(
    { pillForeground: "#1a1b26", pillTextColors: { git: "#abcdef", bad: "nope" } },
    PRESETS,
  );
  assert.equal(cfg.pillForeground, "#1a1b26");
  assert.deepEqual(cfg.pillTextColors, { git: "#abcdef" });
  assert.equal(parsePowerlineConfig({ pillForeground: "text" }, PRESETS).pillForeground, "text");
  assert.equal(parsePowerlineConfig({ pillForeground: "bad color" }, PRESETS).pillForeground, "");
});

test("parsePowerlineConfig reads pillColors + pillGroups", () => {
  const cfg = parsePowerlineConfig(
    { pillColors: { path: "#123456", git: "nope" }, pillGroups: [["path", "git"], "bad", [42]] },
    PRESETS,
  );
  assert.deepEqual(cfg.pillColors, { path: "#123456" }, "invalid hex dropped");
  assert.deepEqual(cfg.pillGroups, [["path", "git"]], "non-array/empty groups dropped");
});

test("wrapInPillGroup adds bold SGR when bold=true", () => {
  const plain = wrapInPillGroup([{ content: "x", bg: "#000000", fg: "#ffffff" }]);
  const bold = wrapInPillGroup([{ content: "x", bg: "#000000", fg: "#ffffff" }], true);
  assert.ok(!plain.includes("\x1b[1m"), "no bold by default");
  assert.ok(bold.includes("\x1b[1m"), "bold code present when enabled");
});

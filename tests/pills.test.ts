import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parsePowerlineConfig } from "../powerline-config.ts";
import {
  buildPillUnits,
  DEFAULT_PILL_BACKGROUND,
  PILL_LEFT_CAP,
  PILL_RIGHT_CAP,
  wrapInPill,
  wrapInPillGroup,
} from "../pills.ts";

const PRESETS = ["default", "full"] as const;
const reset = "\x1b[0m";

test("wrapInPill adds rounded caps and a background fill", () => {
  const pill = wrapInPill("\x1b[38;2;1;2;3mmodel\x1b[0m", "#3b4252");

  assert.ok(pill.includes(PILL_LEFT_CAP));
  assert.ok(pill.includes(PILL_RIGHT_CAP));
  assert.ok(pill.includes("\x1b[48;2;59;66;82m"));
  assert.ok(pill.includes("model"));
  assert.equal(visibleWidth(pill), visibleWidth("model") + visibleWidth(PILL_LEFT_CAP) + visibleWidth(PILL_RIGHT_CAP) + 1);
});

test("pill rendering supports terminal ANSI palette colors", () => {
  const pill = wrapInPillGroup([{
    content: "icon text",
    bg: "ansi:12",
    fg: "ansi:7",
    iconFg: "ansi:8",
  }]);

  assert.ok(pill.startsWith(`\x1b[38;5;12m${PILL_LEFT_CAP}${reset}`));
  assert.ok(pill.includes("\x1b[48;5;12m"));
  assert.ok(pill.includes("\x1b[38;5;8micon\x1b[38;5;7m text"));
  assert.ok(pill.endsWith(`\x1b[38;5;12m${PILL_RIGHT_CAP}${reset}`));
});

test("pill rendering supports the terminal-default foreground", () => {
  const pill = wrapInPillGroup([{
    content: "icon text",
    bg: "ansi:12",
    fg: "default",
    iconFg: "ansi:8",
  }]);

  assert.ok(pill.includes("\x1b[38;5;8micon\x1b[39m text"));
  assert.ok(!pill.includes("\x1b[38;5;15m"));
});

test("pill rendering reasserts background after embedded resets", () => {
  const content = `\x1b[38;2;1;1;1mA${reset}\x1b[38;2;2;2;2mB${reset}`;
  const pill = wrapInPill(content, "#000000");

  assert.ok(pill.split(`${reset}\x1b[48;2;0;0;0m`).length - 1 >= 2);
});

test("wrapInPillGroup renders one multi-color capsule", () => {
  const pill = wrapInPillGroup([
    { content: "dir", bg: "#010203" },
    { content: "git", bg: "#0a0b0c", leadingSpace: true, trailingSpace: false },
  ]);

  assert.equal(pill.split(PILL_LEFT_CAP).length - 1, 1);
  assert.equal(pill.split(PILL_RIGHT_CAP).length - 1, 1);
  assert.ok(pill.includes("\x1b[48;2;1;2;3m"));
  assert.ok(pill.includes("\x1b[48;2;10;11;12m"));
  assert.ok(pill.includes("m git"));
  assert.ok(!pill.includes(`git ${reset}`));
});

test("cost pills omit the trailing spacer after subscription text", () => {
  const units = buildPillUnits([{ id: "cost", content: "(sub)" }], [], {}, "#000000");
  assert.equal(units[0]![0]!.trailingSpace, false);

  const pill = wrapInPillGroup(units[0]!);
  assert.ok(!pill.includes(`(sub) ${reset}`));
});

test("buildPillUnits groups only adjacent configured segments", () => {
  const parts = [
    { id: "path", content: "~/dev" },
    { id: "git", content: "main" },
    { id: "model", content: "gpt" },
    { id: "thinking", content: "med" },
    { id: "time_spent", content: "3s" },
  ];
  const units = buildPillUnits(
    parts,
    [["path", "git"], ["model", "thinking"]],
    { path: "#111111", git: "#222222", model: "#333333", thinking: "#444444" },
    "#999999",
  );

  assert.equal(units.length, 3);
  assert.deepEqual(units[0]!.map((segment) => segment.bg), ["#111111", "#222222"]);
  assert.deepEqual(units[1]!.map((segment) => segment.bg), ["#333333", "#444444"]);
  assert.equal(units[0]![1]!.leadingSpace, true);
  assert.equal(units[0]![1]!.trailingSpace, false);

  const separated = buildPillUnits(
    [parts[0]!, parts[2]!, parts[1]!],
    [["path", "git"]],
    {},
    "#000000",
  );
  assert.equal(separated.length, 3);
});

test("buildPillUnits prefers state-aware colors and falls back to the segment color", () => {
  const units = buildPillUnits(
    [
      { id: "git", content: "clean", pillColorKey: "gitClean" },
      { id: "git", content: "dirty", pillColorKey: "gitDirty" },
      { id: "git", content: "fallback", pillColorKey: "gitUnknown" },
    ],
    [],
    { git: "#111111", gitClean: "#222222", gitDirty: "ansi:9" },
    "#000000",
    { git: "ansi:0", gitClean: "default", gitDirty: "ansi:0" },
    "ansi:7",
    { git: "#333333", gitDirty: "#444444" },
  );

  assert.equal(units[0]![0]!.bg, "#222222");
  assert.equal(units[0]![0]!.fg, "default");
  assert.equal(units[0]![0]!.iconFg, "#333333");
  assert.equal(units[1]![0]!.bg, "ansi:9");
  assert.equal(units[1]![0]!.fg, "ansi:0");
  assert.equal(units[1]![0]!.iconFg, "#444444");
  assert.equal(units[2]![0]!.bg, "#111111");
  assert.equal(units[2]![0]!.fg, "ansi:0");
  assert.equal(units[2]![0]!.iconFg, "#333333");
});

test("buildPillUnits applies default and per-segment icon foregrounds", () => {
  const units = buildPillUnits(
    [
      { id: "path", content: "icon path" },
      { id: "git", content: "icon git" },
    ],
    [],
    {},
    "#000000",
    { git: "#eeeeee" },
    "#dddddd",
    { git: "#222222" },
    "#333333",
  );

  assert.equal(units[0]![0]!.fg, "#dddddd");
  assert.equal(units[0]![0]!.iconFg, "#333333");
  assert.equal(units[1]![0]!.fg, "#eeeeee");
  assert.equal(units[1]![0]!.iconFg, "#222222");
});

test("pill foregrounds separately color a leading icon and text", () => {
  const pill = wrapInPillGroup(
    [{
      content: "\x1b[38;2;9;9;9micon text\x1b[0m",
      bg: "#000000",
      fg: "#abcdef",
      iconFg: "#123456",
    }],
    true,
  );

  assert.ok(!pill.includes("38;2;9;9;9m"));
  assert.ok(pill.includes("\x1b[38;2;18;52;86micon\x1b[38;2;171;205;239m text"));
  assert.ok(pill.includes("\x1b[1m"));
});

test("parsePowerlineConfig validates pill settings", () => {
  const config = parsePowerlineConfig({
    pills: true,
    pillBackground: "#1a2b3c",
    pillColors: { path: "#123456", gitClean: "ansi:10", gitDirty: "ansi:9", bad: "nope" },
    pillForeground: "#232136",
    pillTextColors: { git: "#abcdef", bad: "nope" },
    pillIconForeground: "#575279",
    pillIconColors: { git: "#393552", bad: "nope" },
    pillGroups: [["path", "git", "path"], "bad", [42]],
    alwaysShowTokens: true,
    bold: true,
    nerdFonts: true,
  }, PRESETS);

  assert.equal(config.pills, true);
  assert.equal(config.pillBackground, "#1a2b3c");
  assert.deepEqual(config.pillColors, { path: "#123456", gitClean: "ansi:10", gitDirty: "ansi:9" });
  assert.equal(config.pillForeground, "#232136");
  assert.deepEqual(config.pillTextColors, { git: "#abcdef" });
  assert.equal(config.pillIconForeground, "#575279");
  assert.deepEqual(config.pillIconColors, { git: "#393552" });
  assert.deepEqual(config.pillGroups, [["path", "git"]]);
  assert.equal(config.alwaysShowTokens, true);
  assert.equal(config.bold, true);
  assert.equal(config.nerdFonts, true);
});

test("parsePowerlineConfig accepts terminal ANSI palette colors", () => {
  const config = parsePowerlineConfig({
    pillBackground: "ANSI:0",
    pillColors: { path: "ansi:12", bad: "ansi:16" },
    pillForeground: "ansi:7",
    pillTextColors: { git: "ANSI:15" },
    pillIconForeground: "ansi:8",
    pillIconColors: { git: "ansi:0" },
  }, PRESETS);

  assert.equal(config.pillBackground, "ansi:0");
  assert.deepEqual(config.pillColors, { path: "ansi:12" });
  assert.equal(config.pillForeground, "ansi:7");
  assert.deepEqual(config.pillTextColors, { git: "ansi:15" });
  assert.equal(config.pillIconForeground, "ansi:8");
  assert.deepEqual(config.pillIconColors, { git: "ansi:0" });
});

test("parsePowerlineConfig accepts terminal-default foregrounds", () => {
  const config = parsePowerlineConfig({
    pillForeground: "DEFAULT",
    pillTextColors: { cost: "default" },
    pillIconForeground: "default",
    pillIconColors: { git: "default" },
  }, PRESETS);

  assert.equal(config.pillForeground, "default");
  assert.deepEqual(config.pillTextColors, { cost: "default" });
  assert.equal(config.pillIconForeground, "default");
  assert.deepEqual(config.pillIconColors, { git: "default" });
});

test("invalid pill settings fall back safely", () => {
  const config = parsePowerlineConfig({
    pillBackground: "red",
    pillForeground: "text",
    pillIconForeground: "muted",
    pillColors: [],
    pillIconColors: [],
    pillGroups: "path",
    nerdFonts: "yes",
  }, PRESETS);

  assert.equal(config.pills, false);
  assert.equal(config.pillBackground, DEFAULT_PILL_BACKGROUND);
  assert.equal(config.pillForeground, "");
  assert.equal(config.pillIconForeground, "");
  assert.deepEqual(config.pillColors, {});
  assert.deepEqual(config.pillIconColors, {});
  assert.deepEqual(config.pillGroups, []);
  assert.equal(config.nerdFonts, null);
});

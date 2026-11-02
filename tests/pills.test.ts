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

test("pill foreground overrides embedded segment colors and supports bold", () => {
  const pill = wrapInPillGroup(
    [{ content: "\x1b[38;2;9;9;9micon text\x1b[0m", bg: "#000000", fg: "#abcdef" }],
    true,
  );

  assert.ok(!pill.includes("38;2;9;9;9m"));
  assert.ok(pill.includes("\x1b[38;2;171;205;239m"));
  assert.ok(pill.includes("\x1b[1m"));
});

test("parsePowerlineConfig validates pill settings", () => {
  const config = parsePowerlineConfig({
    pills: true,
    pillBackground: "#1a2b3c",
    pillColors: { path: "#123456", bad: "nope" },
    pillForeground: "#232136",
    pillTextColors: { git: "#abcdef", bad: "nope" },
    pillGroups: [["path", "git", "path"], "bad", [42]],
    alwaysShowTokens: true,
    bold: true,
    nerdFonts: true,
  }, PRESETS);

  assert.equal(config.pills, true);
  assert.equal(config.pillBackground, "#1a2b3c");
  assert.deepEqual(config.pillColors, { path: "#123456" });
  assert.equal(config.pillForeground, "#232136");
  assert.deepEqual(config.pillTextColors, { git: "#abcdef" });
  assert.deepEqual(config.pillGroups, [["path", "git"]]);
  assert.equal(config.alwaysShowTokens, true);
  assert.equal(config.bold, true);
  assert.equal(config.nerdFonts, true);
});

test("invalid pill settings fall back safely", () => {
  const config = parsePowerlineConfig({
    pillBackground: "red",
    pillForeground: "text",
    pillColors: [],
    pillGroups: "path",
    nerdFonts: "yes",
  }, PRESETS);

  assert.equal(config.pills, false);
  assert.equal(config.pillBackground, DEFAULT_PILL_BACKGROUND);
  assert.equal(config.pillForeground, "");
  assert.deepEqual(config.pillColors, {});
  assert.deepEqual(config.pillGroups, []);
  assert.equal(config.nerdFonts, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { appendWorkingStatusSuffix, renderCompletedWorkingStatusBorder } from "../bash-mode/editor.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

test("appends the working timer inside the editor border", () => {
  const border = "\x1b[35m── Waiting\x1b[35m────────────\x1b[0m";
  const rendered = appendWorkingStatusSuffix(border, "21s");
  const plain = stripAnsi(rendered);

  assert.match(plain, /── Waiting 21s ─/);
  assert.ok(!plain.includes("Waiting  21s"), "status and timer should have one separator space");
  assert.equal(visibleWidth(rendered), visibleWidth(border));
});

test("leaves a narrow border unchanged when the timer cannot fit", () => {
  const border = "── Waiting─";
  assert.equal(appendWorkingStatusSuffix(border, "21s"), border);
});

test("renders the completed timer after Pi removes its status indicator", () => {
  const rendered = renderCompletedWorkingStatusBorder((text) => `\x1b[35m${text}\x1b[0m`, 40, "#2 ◷ 21s");
  assert.ok(rendered);
  const plain = stripAnsi(rendered);
  assert.match(plain, /#2 ◷ 21s/);
  assert.ok(!plain.includes("Waiting"), "completed status should not keep Pi's idle label");
  assert.equal(visibleWidth(rendered), 40);
});

test("resets the working timer and increments the turn for each agent turn", () => {
  assert.match(source, /turnCount = 0/);
  assert.match(source, /pi\.on\("agent_start"[\s\S]*?turnCount \+= 1[\s\S]*?startWorkingStatusTimer\(\)/);
  assert.match(source, /pi\.on\("agent_end"[\s\S]*?completedDuration[\s\S]*?stopWorkingStatusTimer\(\)/);
  assert.match(source, /COMPLETED_TURN_DISPLAY_MS = 10_000/);
  assert.match(source, /completedTurnDurationMs = completedDuration/);
  assert.match(source, /workingTurnStartTime = Date\.now\(\)/);
  assert.match(source, /Date\.now\(\) - workingTurnStartTime/);
  assert.match(source, /`#\$\{turnCount\} \$\{getIcons\(\)\.time\}/);
});

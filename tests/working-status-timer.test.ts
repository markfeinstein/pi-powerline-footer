import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { appendWorkingStatusSuffix } from "../bash-mode/editor.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

test("appends the working timer inside the editor border", () => {
  const border = "\x1b[35m── Waiting\x1b[35m────────────\x1b[0m";
  const rendered = appendWorkingStatusSuffix(border, "21s");
  const plain = stripAnsi(rendered);

  assert.match(plain, /── Waiting 21s ─/);
  assert.equal(visibleWidth(rendered), visibleWidth(border));
});

test("leaves a narrow border unchanged when the timer cannot fit", () => {
  const border = "── Waiting─";
  assert.equal(appendWorkingStatusSuffix(border, "21s"), border);
});

test("resets the working timer for each agent turn", () => {
  assert.match(source, /pi\.on\("agent_start"[\s\S]*?startWorkingStatusTimer\(\)/);
  assert.match(source, /pi\.on\("agent_end"[\s\S]*?stopWorkingStatusTimer\(\)/);
  assert.match(source, /workingTurnStartTime = Date\.now\(\)/);
  assert.match(source, /Date\.now\(\) - workingTurnStartTime/);
});

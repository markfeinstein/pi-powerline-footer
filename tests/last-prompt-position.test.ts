import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderFixedEditorCluster } from "../fixed-editor/cluster.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";

const PRESETS = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

const base = {
  width: 40,
  terminalRows: 12,
  editorLines: ["> prompt"],
  lastPromptLines: ["LAST PROMPT"],
};

test("last prompt renders below the editor by default", () => {
  const { lines } = renderFixedEditorCluster(base);
  assert.ok(lines.indexOf("LAST PROMPT") > lines.indexOf("> prompt"), "last prompt should be below editor");
});

test("lastPromptPosition 'below' keeps last prompt below the editor", () => {
  const { lines } = renderFixedEditorCluster({ ...base, lastPromptPosition: "below" });
  assert.ok(lines.indexOf("LAST PROMPT") > lines.indexOf("> prompt"));
});

test("lastPromptPosition 'above' moves last prompt above the editor", () => {
  const { lines } = renderFixedEditorCluster({ ...base, lastPromptPosition: "above" });
  assert.ok(lines.indexOf("LAST PROMPT") < lines.indexOf("> prompt"), "last prompt should be above editor");
});

test("lastPromptAboveInput config selects above-editor last prompt position", () => {
  const config = parsePowerlineConfig({ lastPromptAboveInput: true }, PRESETS);

  assert.equal(config.lastPromptAboveInput, true);
  assert.match(source, /lastPromptPosition: config\.lastPromptAboveInput \? "above" : "below"/);
});

test("lastPromptPosition 'above' stays below status and top rows", () => {
  const { lines } = renderFixedEditorCluster({
    ...base,
    statusLines: ["STATUS"],
    topLines: ["TOP"],
    lastPromptPosition: "above",
  });
  assert.ok(lines.indexOf("STATUS") < lines.indexOf("LAST PROMPT"));
  assert.ok(lines.indexOf("TOP") < lines.indexOf("LAST PROMPT"));
  assert.ok(lines.indexOf("LAST PROMPT") < lines.indexOf("> prompt"));
});

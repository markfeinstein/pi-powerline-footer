import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderFixedEditorCluster } from "../fixed-editor/cluster.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";

const PRESETS = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");

// "TOP" stands in for the main powerline bar (primary segments), which the
// extension renders as topLines. "STATUS" is the notification status row.
const base = {
  width: 40,
  terminalRows: 12,
  statusLines: ["STATUS"],
  topLines: ["TOP"],
  editorLines: ["> prompt"],
};

test("bar and status render above the editor by default", () => {
  const { lines } = renderFixedEditorCluster(base);
  assert.ok(lines.indexOf("TOP") < lines.indexOf("> prompt"), "bar should be above editor");
  assert.ok(lines.indexOf("STATUS") < lines.indexOf("> prompt"), "status should be above editor");
});

test("statusPosition 'above' keeps the bar above the editor", () => {
  const { lines } = renderFixedEditorCluster({ ...base, statusPosition: "above" });
  assert.ok(lines.indexOf("TOP") < lines.indexOf("> prompt"));
  assert.ok(lines.indexOf("STATUS") < lines.indexOf("> prompt"));
});

test("statusPosition 'below' moves the bar (and status) below the editor", () => {
  const { lines } = renderFixedEditorCluster({ ...base, statusPosition: "below" });
  assert.ok(lines.indexOf("TOP") > lines.indexOf("> prompt"), "bar should be below editor");
  assert.ok(lines.indexOf("STATUS") > lines.indexOf("> prompt"), "status should be below editor");
});

test("statusBelowPrompt config selects below-editor status position", () => {
  const config = parsePowerlineConfig({ statusBelowPrompt: true }, PRESETS);

  assert.equal(config.statusBelowPrompt, true);
  assert.match(source, /statusPosition: config\.statusBelowPrompt \? "below" : "above"/);
});

test("statusPosition 'below' keeps the bar above secondary/transcript rows", () => {
  const { lines } = renderFixedEditorCluster({
    ...base,
    secondaryLines: ["SECONDARY"],
    transcriptLines: ["TRANSCRIPT"],
    statusPosition: "below",
  });
  assert.ok(lines.indexOf("> prompt") < lines.indexOf("TOP"));
  assert.ok(lines.indexOf("TOP") < lines.indexOf("SECONDARY"));
  assert.ok(lines.indexOf("SECONDARY") < lines.indexOf("TRANSCRIPT"));
});

test("blank status rows are dropped (no gap between editor and bar)", () => {
  const { lines } = renderFixedEditorCluster({
    ...base,
    statusLines: ["", "   "],
    statusPosition: "below",
  });
  // editor directly followed by the bar, no empty line wedged between
  const editorIdx = lines.indexOf("> prompt");
  assert.equal(lines[editorIdx + 1], "TOP");
  assert.ok(!lines.some((l) => l === "" || l.trim() === ""), "no blank rows remain");
});

test("aboveEditor widgets stay above the editor even when status is below", () => {
  // Regression: third-party aboveEditor widgets (e.g. a todo list) must not be
  // dragged below the editor by statusBelowPrompt the way powerline status is.
  const { lines } = renderFixedEditorCluster({
    ...base,
    aboveEditorWidgetLines: ["TODO"],
    statusPosition: "below",
  });
  assert.ok(lines.indexOf("TODO") < lines.indexOf("> prompt"), "widget should be above editor");
  assert.ok(lines.indexOf("> prompt") < lines.indexOf("TOP"), "powerline bar should be below editor");
  assert.ok(lines.indexOf("> prompt") < lines.indexOf("STATUS"), "powerline status should be below editor");
});

test("aboveEditor widgets render below the last-prompt ghost and above the editor", () => {
  const { lines } = renderFixedEditorCluster({
    ...base,
    aboveEditorWidgetLines: ["TODO"],
    lastPromptLines: ["GHOST"],
    lastPromptPosition: "above",
    statusPosition: "below",
  });
  assert.ok(lines.indexOf("TODO") < lines.indexOf("GHOST"), "widget above the ghost prompt");
  assert.ok(lines.indexOf("GHOST") < lines.indexOf("> prompt"), "ghost directly above editor");
});

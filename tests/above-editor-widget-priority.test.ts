import test from "node:test";
import assert from "node:assert/strict";
import { renderFixedEditorCluster } from "../fixed-editor/cluster.ts";

test("aboveEditor widgets keep priority over below-editor status rows", () => {
  const { lines } = renderFixedEditorCluster({
    width: 80,
    terminalRows: 4,
    editorLines: ["> prompt"],
    aboveEditorWidgetLines: ["TODO"],
    statusLines: ["STATUS"],
    topLines: ["TOP-1", "TOP-2", "TOP-3"],
    statusPosition: "below",
  });

  assert.ok(lines.includes("TODO"), "widget should stay visible");
  assert.ok(lines.indexOf("TODO") < lines.indexOf("> prompt"), "widget should stay above the editor");
  assert.ok(lines.indexOf("> prompt") < lines.indexOf("STATUS"), "status should stay below the editor");
});

import test from "node:test";
import assert from "node:assert/strict";
import { droppedPathTextFromInput } from "../bash-mode/editor.ts";

test("dropped file URI lists decode to plain paths", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~file:///Users/me/My%20File.txt\x1b[201~"),
    "/Users/me/My File.txt",
  );
});

test("dropped Finder paths preserve existing escaping", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~/Users/me/Project\\ Folder\x1b[201~"),
    "/Users/me/Project\\ Folder",
  );
});

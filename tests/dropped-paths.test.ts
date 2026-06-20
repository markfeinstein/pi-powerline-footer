import test from "node:test";
import assert from "node:assert/strict";
import { droppedPathTextFromInput } from "../bash-mode/editor.ts";

test("dropped file URI lists decode to plain paths", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~file:///Users/me/My%20File.txt\x1b[201~"),
    "/Users/me/My File.txt",
  );
});

test("dropped file URI lists shell-escape paths in shell contexts", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~file:///Users/me/My%20File%20$draft%3B.txt\x1b[201~", { shellEscape: true }),
    "/Users/me/My\\ File\\ \\$draft\\;.txt",
  );
});

test("dropped Finder paths preserve existing escaping", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~/Users/me/Project\\ Folder\x1b[201~"),
    "/Users/me/Project\\ Folder",
  );
});

test("dropped file URI lists strip decoded terminal controls", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~file:///Users/me/Project%1B%5D52%3Bc%3Bsecret%07red.txt\x1b[201~"),
    "/Users/me/Projectred.txt",
  );
});

test("dropped file URI lists can shell-escape decoded paths", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~file:///tmp/a%3Btouch%20x\x1b[201~", { shellEscape: true }),
    "/tmp/a\\;touch\\ x",
  );
});

test("dropped Finder paths shell-escape metacharacters in shell contexts", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~/Users/me/Project Folder/$draft;one\x1b[201~", { shellEscape: true }),
    "/Users/me/Project\\ Folder/\\$draft\\;one",
  );
});

test("dropped Finder paths do not double-escape existing shell escapes", () => {
  assert.equal(
    droppedPathTextFromInput("\x1b[200~/Users/me/Project\\ Folder\x1b[201~", { shellEscape: true }),
    "/Users/me/Project\\ Folder",
  );
});

test("raw dropped paths can shell-escape metacharacters", () => {
  assert.equal(droppedPathTextFromInput("/tmp/a;touch x", { shellEscape: true }), "/tmp/a\\;touch\\ x");
});

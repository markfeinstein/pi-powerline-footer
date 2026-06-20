import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitizeClipboardText, sanitizePromptInsertionText, sanitizeSingleLineUiText } from "../index.ts";

test("sanitizeSingleLineUiText strips terminal controls and line breaks", () => {
  assert.equal(sanitizeSingleLineUiText("ok\x1b]52;c;secret\x07\x1b[2J\nnext\ttab"), "ok next tab");
});

test("sanitizeClipboardText strips controls while preserving ordinary whitespace", () => {
  assert.equal(sanitizeClipboardText("a\n\tb\x1b]52;c;secret\x07\x1b[2J"), "a\n\tb");
});

test("sanitizePromptInsertionText strips controls from selected history text", () => {
  assert.equal(sanitizePromptInsertionText("keep\nthis\x1b]52;c;secret\x07\x1b[2J"), "keep\nthis");
});

test("terminal-visible prompt, overlay, clipboard, and vibe paths use sanitizers", () => {
  const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf-8");

  assert.match(source, /const compact = sanitizeSingleLineUiText\(text\)\.replace/);
  assert.match(source, /const safeText = sanitizeStyledUiLine\(text\)/);
  assert.match(source, /copyToClipboard\(sanitizeClipboardText\(text\)\)/);
  assert.match(source, /const selectedText = sanitizePromptInsertionText\(selected\)/);
  assert.match(source, /ctx\.ui\.setEditorText\(selectedText\)/);
  assert.match(source, /let promptText = sanitizeSingleLineUiText\(lastUserPrompt\)/);
  assert.match(source, /const displayModelSpec = getVibeModel\(\)/);
  assert.match(source, /const displayTheme = sanitizeSingleLineUiText\(theme\)\.trim\(\) \|\| "\(empty\)"/);
});

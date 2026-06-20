import test from "node:test";
import assert from "node:assert/strict";
import { stripTerminalControlSequences, stripUnsafeTerminalControlSequences } from "../sanitize.ts";

test("stripTerminalControlSequences removes C1 CSI controls while preserving text", () => {
  assert.equal(stripTerminalControlSequences("safe\u009b31mRED\u009b0m text"), "safeRED text");
});

test("stripTerminalControlSequences removes C1 OSC strings", () => {
  assert.equal(stripTerminalControlSequences("safe\u009d52;c;secret\u009c text"), "safe text");
});

test("stripTerminalControlSequences drops unterminated string-control payloads", () => {
  assert.equal(stripTerminalControlSequences("safe\x1b]52;c;secret"), "safe");
  assert.equal(stripTerminalControlSequences("safe\x1bPsecret"), "safe");
  assert.equal(stripTerminalControlSequences("safe\x1b_secret"), "safe");
});

test("stripTerminalControlSequences keeps tabs and line breaks for callers to normalize", () => {
  assert.equal(stripTerminalControlSequences("a\t\nb\r"), "a\t\nb\r");
});

test("stripUnsafeTerminalControlSequences preserves SGR but removes unsafe controls", () => {
  const input = "\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;secret\x07\u009b31mc1";
  const stripped = stripUnsafeTerminalControlSequences(input);

  assert.equal(stripped, "\x1b[31mred\x1b[0mc1");
  assert.doesNotMatch(stripped, /\x1b\[2J/);
  assert.doesNotMatch(stripped, /secret/);
  assert.doesNotMatch(stripped, /\u009b/);
});

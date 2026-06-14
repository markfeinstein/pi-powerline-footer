import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { joinLeftRight } from "../layout.ts";
import { reserveSpinnerSlot, SPINNER_SLOT_RESERVE } from "../fixed-editor/cluster.ts";

test("joinLeftRight returns null when both sides are empty", () => {
  assert.equal(joinLeftRight("", "", 80), null);
});

test("joinLeftRight returns the left content unchanged when there is no right group", () => {
  assert.equal(joinLeftRight(" left ", "", 80), " left ");
});

test("joinLeftRight right-aligns the right group flush to availableWidth", () => {
  const out = joinLeftRight("ab", "yz", 10);
  assert.notEqual(out, null);
  assert.equal(visibleWidth(out!), 10);
  assert.ok(out!.startsWith("ab"));
  assert.ok(out!.endsWith("yz"));
  // 10 - 2 (left) - 2 (right) = 6 spaces of padding between the groups.
  assert.equal(out, "ab" + " ".repeat(6) + "yz");
});

test("joinLeftRight right-aligns when there is no left group", () => {
  const out = joinLeftRight("", "yz", 6);
  assert.equal(out, " ".repeat(4) + "yz");
  assert.equal(visibleWidth(out!), 6);
});

test("joinLeftRight returns null when the groups cannot fit side by side", () => {
  assert.equal(joinLeftRight("aaaaa", "bbbbb", 8), null);
});

test("joinLeftRight allows the groups to exactly fill the row", () => {
  const out = joinLeftRight("aaaa", "bbbb", 8);
  assert.equal(out, "aaaabbbb");
  assert.equal(visibleWidth(out!), 8);
});

test("joinLeftRight measures visible width, ignoring ANSI color codes", () => {
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const left = `${red}ab${reset}`; // visible width 2
  const right = `${red}yz${reset}`; // visible width 2
  const out = joinLeftRight(left, right, 10);
  assert.notEqual(out, null);
  assert.equal(visibleWidth(out!), 10);
  assert.ok(out!.startsWith(left));
  assert.ok(out!.endsWith(right));
});

// Regression: when the inline working-status spinner slot is reserved on the
// fixed-editor bar, it strips the bar's single leading space and prepends a
// 3-column slot. A right-aligned top line padded to the full width would then
// overflow by SPINNER_SLOT_RESERVE columns and wrap/truncate the rightmost
// segment's glyphs. Reserving that width up front keeps the composed line within
// the terminal width.
test("right-aligned bar plus reserved spinner slot stays within the terminal width", () => {
  const width = 40;
  const left = " left"; // single leading space, like buildContentFromParts output
  const right = "right ";
  const top = joinLeftRight(left, right, width - SPINNER_SLOT_RESERVE);
  assert.notEqual(top, null);
  assert.equal(visibleWidth(top!), width - SPINNER_SLOT_RESERVE);
  // Empty spinner (idle): slot renders as blanks but still reserves its width.
  const composedIdle = reserveSpinnerSlot(top!, "");
  assert.equal(visibleWidth(composedIdle), width);
  // Active spinner glyph: still a one-column slot, so width is unchanged.
  const composedBusy = reserveSpinnerSlot(top!, "\u280b Working…");
  assert.equal(visibleWidth(composedBusy), width);
});

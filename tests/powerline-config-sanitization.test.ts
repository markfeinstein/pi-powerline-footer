import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtensionStatusValue, parsePowerlineConfig } from "../powerline-config.ts";

test("custom item prefixes are normalized to a single status-bar line", () => {
  const config = parsePowerlineConfig(
    {
      customItems: [
        { id: "ci", prefix: "CI\nnext\rline\ttab" },
      ],
    },
    ["default"],
  );

  assert.equal(config.customItems[0].prefix, "CI next line tab");
});

test("extension status values are normalized to a single status-bar line", () => {
  assert.equal(normalizeExtensionStatusValue("ok\nnext\rline\ttab"), "ok next line tab");
});

test("custom item colors use the same validation as other color config", () => {
  const config = parsePowerlineConfig(
    {
      customItems: [
        { id: "hex", color: "#abcdef" },
        { id: "theme", color: "warning" },
        { id: "bad", color: "not a color" },
        { id: "escape", color: "\x1b[31mred" },
      ],
    },
    ["default"],
  );

  assert.equal(config.customItems.find((item) => item.id === "hex")?.color, "#abcdef");
  assert.equal(config.customItems.find((item) => item.id === "theme")?.color, "warning");
  assert.equal(config.customItems.find((item) => item.id === "bad")?.color, undefined);
  assert.equal(config.customItems.find((item) => item.id === "escape")?.color, undefined);
});

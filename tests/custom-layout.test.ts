import test from "node:test";
import assert from "node:assert/strict";
import { applyCustomLayout, parsePowerlineConfig } from "../powerline-config.ts";
import { getPreset } from "../presets.ts";

const PRESETS = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;

test("parsePowerlineConfig reads a full custom layout", () => {
  const config = parsePowerlineConfig(
    {
      preset: "custom",
      custom: {
        leftSegments: ["git", "path", "model", "thinking"],
        rightSegments: ["time_spent"],
        secondarySegments: ["extension_statuses"],
        separator: "pipe",
      },
    },
    PRESETS,
  );

  assert.equal(config.preset, "custom");
  assert.deepEqual(config.custom, {
    leftSegments: ["git", "path", "model", "thinking"],
    rightSegments: ["time_spent"],
    secondarySegments: ["extension_statuses"],
    separator: "pipe",
  });
});

test("custom layout drops unknown segment ids and bad separators", () => {
  const config = parsePowerlineConfig(
    {
      preset: "custom",
      custom: {
        leftSegments: ["git", "bogus", "model", "git"],
        separator: "rainbow",
      },
    },
    PRESETS,
  );

  // unknown removed, duplicates de-duped, order preserved
  assert.deepEqual(config.custom?.leftSegments, ["git", "model"]);
  // invalid separator omitted entirely
  assert.equal(config.custom?.separator, undefined);
});

test("custom is null when no custom block is present", () => {
  const config = parsePowerlineConfig({ preset: "custom" }, PRESETS);
  assert.equal(config.custom, null);
});

test("applyCustomLayout overrides the custom preset", () => {
  const config = parsePowerlineConfig(
    {
      preset: "custom",
      custom: {
        leftSegments: ["git", "path", "model", "thinking", "cache_read", "context_total"],
        rightSegments: ["time_spent"],
        separator: "pipe",
      },
    },
    PRESETS,
  );

  const resolved = applyCustomLayout(getPreset(config.preset), config);
  assert.deepEqual(resolved.leftSegments, ["git", "path", "model", "thinking", "cache_read", "context_total"]);
  assert.deepEqual(resolved.rightSegments, ["time_spent"]);
  assert.equal(resolved.separator, "pipe");
});

test("applyCustomLayout falls back to preset fields when omitted", () => {
  const config = parsePowerlineConfig(
    { preset: "custom", custom: { separator: "pipe" } },
    PRESETS,
  );

  const base = getPreset("custom");
  const resolved = applyCustomLayout(base, config);
  // only separator overridden; segments untouched
  assert.deepEqual(resolved.leftSegments, base.leftSegments);
  assert.deepEqual(resolved.rightSegments, base.rightSegments);
  assert.equal(resolved.separator, "pipe");
});

test("applyCustomLayout is a no-op for non-custom presets", () => {
  const config = parsePowerlineConfig(
    { preset: "full", custom: { separator: "pipe" } },
    PRESETS,
  );

  const base = getPreset("full");
  const resolved = applyCustomLayout(base, config);
  assert.equal(resolved.separator, base.separator);
});

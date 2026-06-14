import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression guard: the module-level `let config = loadConfig()` runs at import
// time and reads ~/.pi/agent/settings.json. If MAX_SETTINGS_FILE_BYTES (used by
// readSettingsForLoad) were declared after that initializer, the size check would
// hit a temporal-dead-zone ReferenceError that readSettingsForLoad swallows,
// silently dropping the user's persisted vibe settings. This test loads the
// module against a real settings file and asserts the value survives.
test("working-vibes loads persisted settings at module init", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-init-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ workingVibe: "noir", workingVibeMode: "file" }),
  );

  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    // First import of working-vibes in this process triggers loadConfig().
    const mod = await import("../working-vibes.ts");
    assert.equal(mod.getVibeTheme(), "noir");
    assert.equal(mod.getVibeMode(), "file");
  } finally {
    if (original === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = original;
    }
  }
});

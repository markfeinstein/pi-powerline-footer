import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import powerlineFooter from "../index.ts";

function mkTempDir(): string {
  return mkdtempSync(join(tmpdir(), "powerline-footer-settings-read-"));
}

test("powerlineFooter ignores project settings under a symlinked .pi parent", () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const homeDir = mkTempDir();
  const cwd = mkTempDir();
  const targetPiDir = join(homeDir, "project-pi");
  const shortcuts = new Map<string, (ctx: any) => unknown>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(targetPiDir, { recursive: true });
  writeFileSync(join(targetPiDir, "settings.json"), JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+d" } }, null, 2) + "\n");
  symlinkSync(targetPiDir, join(cwd, ".pi"), "dir");
  process.chdir(cwd);

  try {
    powerlineFooter({
      on() {},
      registerCommand() {},
      registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
        shortcuts.set(key, shortcut.handler);
      },
    } as any);

    assert.equal(shortcuts.has("ctrl+alt+d"), false);
    assert.equal(shortcuts.has("ctrl+alt+c"), true);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
  }
});

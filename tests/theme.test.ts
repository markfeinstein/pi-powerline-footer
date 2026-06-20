import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function themeModuleUrl(): string {
  return new URL(`../theme.ts?test=${Date.now()}-${Math.random()}`, import.meta.url).href;
}

test("loadThemeConfig reads user overrides from theme.json", async () => {
  const themePath = join(dirname(fileURLToPath(new URL("../theme.ts", import.meta.url))), "theme.json");
  const backupPath = `${themePath}.bak-${Date.now()}`;
  const hasExisting = existsSync(themePath);
  if (hasExisting) {
    writeFileSync(backupPath, readFileSync(themePath));
  }

  try {
    writeFileSync(themePath, JSON.stringify({ colors: { path: "#123456" } }, null, 2) + "\n");
    const { loadThemeConfig } = await import(themeModuleUrl());
    assert.deepEqual(loadThemeConfig(), { colors: { path: "#123456" } });
  } finally {
    if (existsSync(themePath)) unlinkSync(themePath);
    if (hasExisting) {
      writeFileSync(themePath, readFileSync(backupPath));
      unlinkSync(backupPath);
    }
  }
});

test("loadThemeConfig ignores symlinked theme.json", async () => {
  const themePath = join(dirname(fileURLToPath(new URL("../theme.ts", import.meta.url))), "theme.json");
  const tempDir = mkdtempSync(join(tmpdir(), "powerline-theme-"));
  const targetPath = join(tempDir, "theme.json");
  writeFileSync(targetPath, JSON.stringify({ colors: { path: "#123456" } }, null, 2) + "\n");

  const backupPath = `${themePath}.bak-${Date.now()}`;
  const hasExisting = existsSync(themePath);
  if (hasExisting) writeFileSync(backupPath, readFileSync(themePath));

  try {
    symlinkSync(targetPath, themePath);
    const { loadThemeConfig } = await import(themeModuleUrl());
    assert.deepEqual(loadThemeConfig(), {});
  } finally {
    if (existsSync(themePath)) unlinkSync(themePath);
    if (hasExisting) {
      writeFileSync(themePath, readFileSync(backupPath));
      unlinkSync(backupPath);
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("theme color overrides strip terminal control sequences", async () => {
  const themePath = join(dirname(fileURLToPath(new URL("../theme.ts", import.meta.url))), "theme.json");
  const backupPath = `${themePath}.bak-${Date.now()}`;
  const hasExisting = existsSync(themePath);
  if (hasExisting) writeFileSync(backupPath, readFileSync(themePath));

  try {
    // A hex color smuggling a CSI color sequence and an OSC payload.
    writeFileSync(
      themePath,
      JSON.stringify({ colors: { path: "#123456\u001b[31m\u001b]0;pwn\u0007" } }) + "\n",
    );
    const { resolveColor } = await import(themeModuleUrl());
    const resolved = resolveColor("path");
    assert.equal(resolved, "#123456");
    assert.doesNotMatch(resolved, /\u001b/);
  } finally {
    if (existsSync(themePath)) unlinkSync(themePath);
    if (hasExisting) {
      writeFileSync(themePath, readFileSync(backupPath));
      unlinkSync(backupPath);
    }
  }
});

test("icon overrides strip terminal control sequences and line breaks", async () => {
  const themePath = join(dirname(fileURLToPath(new URL("../theme.ts", import.meta.url))), "theme.json");
  const backupPath = `${themePath}.bak-${Date.now()}`;
  const hasExisting = existsSync(themePath);
  if (hasExisting) writeFileSync(backupPath, readFileSync(themePath));

  try {
    // A branch icon override wrapping the glyph in a color sequence, an OSC
    // payload, and a stray newline.
    writeFileSync(
      themePath,
      JSON.stringify({ icons: { branch: "\u001b[31m\uE0A0\u001b]0;pwn\u0007\n" } }) + "\n",
    );
    const { getIcons } = await import(`../icons.ts?test=${Date.now()}-${Math.random()}`);
    const icons = getIcons();
    assert.equal(icons.branch, "\uE0A0");
    assert.doesNotMatch(icons.branch, /[\u001b\n]/);
  } finally {
    if (existsSync(themePath)) unlinkSync(themePath);
    if (hasExisting) {
      writeFileSync(themePath, readFileSync(backupPath));
      unlinkSync(backupPath);
    }
  }
});

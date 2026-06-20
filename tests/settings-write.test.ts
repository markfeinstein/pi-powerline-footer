import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import powerlineFooter, { getPromptHistoryText, readRecentProjectPrompts, writePowerlineSetting } from "../index.ts";
import { projectStorageKey } from "../project-key.ts";

test("writePowerlineSetting refuses to fall back to global settings when project settings are malformed", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" } }, null, 2) + "\n");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath, "{ not valid json\n");

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { powerline: { preset: "default" } });
    assert.equal(readFileSync(projectSettingsPath, "utf-8"), "{ not valid json\n");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting persists atomically, leaving no temp files behind", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const agentDir = join(homeDir, ".pi", "agent");
  const globalSettingsPath = join(agentDir, "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" }, keep: 1 }, null, 2) + "\n");

  try {
    assert.equal(
      writePowerlineSetting(cwd, (existing) => ({
        ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}),
        preset: "compact",
      })),
      true,
    );

    const parsed = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
    assert.deepEqual(parsed.powerline, { preset: "compact" });
    assert.equal(parsed.keep, 1, "unrelated settings keys must be preserved");

    const leftoverTempFiles = readdirSync(agentDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftoverTempFiles, [], "no temp files should remain after an atomic write");
    if (process.platform !== "win32") {
      assert.equal(statSync(globalSettingsPath).mode & 0o777, 0o600, "settings writes should force private file permissions");
    }
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting writes to project settings when the file exists without powerline", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" } }, null, 2) + "\n");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), true);
    assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath, "utf-8")), { theme: "dark", powerline: { preset: "compact" } });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { powerline: { preset: "default" } });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting writes to global settings when no project settings exist", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), true);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { theme: "dark", powerline: { preset: "compact" } });
    assert.equal(existsSync(projectSettingsPath), false);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting creates global settings when no settings files exist", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), true);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { powerline: { preset: "compact" } });
    assert.equal(existsSync(projectSettingsPath), false);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting refuses symlinked global settings", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const targetPath = join(homeDir, "target-settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(targetPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
  symlinkSync(targetPath, globalSettingsPath);

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
    assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf-8")), { theme: "dark" });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting refuses dangling symlinked global settings", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  symlinkSync(join(homeDir, "missing-settings.json"), globalSettingsPath);

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("powerlineFooter reads symlinked global settings on startup", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const targetPath = join(homeDir, "target-settings.json");
  const shortcuts = new Map<string, (ctx: any) => unknown>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(targetPath, JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+d" } }, null, 2) + "\n");
  symlinkSync(targetPath, globalSettingsPath);

  powerlineFooter({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut.handler);
    },
  } as any);

  try {
    assert.equal(shortcuts.has("ctrl+alt+d"), true);
    assert.equal(shortcuts.has("ctrl+alt+c"), false);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("powerlineFooter ignores symlinked project settings on startup", () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const homeDir = mkTempDir();
  const cwd = mkTempDir();
  const targetPath = join(homeDir, "target-project-settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const shortcuts = new Map<string, (ctx: any) => unknown>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(targetPath, JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+d" } }, null, 2) + "\n");
  symlinkSync(targetPath, projectSettingsPath);
  process.chdir(cwd);

  powerlineFooter({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut.handler);
    },
  } as any);

  try {
    assert.equal(shortcuts.has("ctrl+alt+d"), false);
    assert.equal(shortcuts.has("ctrl+alt+c"), true);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
  }
});

test("powerlineFooter registers session-specific shortcut overrides", async () => {
  const originalHome = process.env.HOME;
  const homeDir = mkTempDir();
  const cwd = mkTempDir();
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => unknown }>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+d" } }, null, 2) + "\n");

  powerlineFooter({
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerShortcut(key: string, shortcut: { description?: string; handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut);
    },
  } as any);

  try {
    assert.equal(shortcuts.has("ctrl+alt+d"), false);
    await handlers.get("session_start")?.[0]?.({ reason: "resume" }, { cwd, hasUI: false });
    assert.equal(shortcuts.has("ctrl+alt+d"), true);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("bash mode shortcut wins over conflicting powerline shortcut", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => unknown }>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ bashMode: { toggleShortcut: "ctrl+alt+c" } }, null, 2) + "\n");

  powerlineFooter({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: { description?: string; handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut);
    },
  } as any);

  try {
    assert.equal(shortcuts.get("ctrl+alt+c")?.description, "Toggle bash mode");
  } finally {
    process.env.HOME = originalHome;
  }
});

for (const unsafeKey of ["__proto__", "constructor", "prototype"] as const) {
  test(`powerlineFooter ignores ${unsafeKey} keys in project settings`, () => {
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    const homeDir = mkTempDir();
    const cwd = mkTempDir();
    const projectSettingsPath = join(cwd, ".pi", "settings.json");
    const shortcuts = new Map<string, (ctx: any) => unknown>();

    process.env.HOME = homeDir;
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      projectSettingsPath,
      JSON.stringify({ [unsafeKey]: { powerlineShortcuts: { copyEditor: "ctrl+alt+d" } } }) + "\n",
    );
    process.chdir(cwd);

    powerlineFooter({
      on() {},
      registerCommand() {},
      registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
        shortcuts.set(key, shortcut.handler);
      },
    } as any);

    try {
      assert.equal(shortcuts.has("ctrl+alt+d"), false);
      assert.equal(shortcuts.has("ctrl+alt+c"), true);
      assert.equal(({} as { powerlineShortcuts?: unknown }).powerlineShortcuts, undefined);
    } finally {
      process.chdir(originalCwd);
      process.env.HOME = originalHome;
    }
  });
}

test("writePowerlineSetting refuses symlinked global settings parent", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const targetDir = mkTempDir();

  process.env.HOME = homeDir;
  symlinkSync(targetDir, join(homeDir, ".pi"));

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting writes project settings when global settings are malformed", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, "{ not valid json\n");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), true);
    assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath, "utf-8")), { theme: "dark", powerline: { preset: "compact" } });
    assert.equal(readFileSync(globalSettingsPath, "utf-8"), "{ not valid json\n");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting refuses symlinked project settings", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const targetPath = join(homeDir, "target-settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" } }, null, 2) + "\n");
  writeFileSync(targetPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  symlinkSync(targetPath, projectSettingsPath);

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
    assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf-8")), { theme: "dark" });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { powerline: { preset: "default" } });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting refuses dangling symlinked project settings", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" } }, null, 2) + "\n");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  symlinkSync(join(homeDir, "missing-project-settings.json"), projectSettingsPath);

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, "utf-8")), { powerline: { preset: "default" } });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("writePowerlineSetting refuses symlinked project settings parent", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const targetDir = mkTempDir();
  const globalSettingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({ powerline: { preset: "default" } }, null, 2) + "\n");
  symlinkSync(targetDir, join(cwd, ".pi"));
  writeFileSync(join(targetDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2) + "\n");

  try {
    assert.equal(writePowerlineSetting(cwd, (existing) => ({ ...(typeof existing === "object" && existing ? existing as Record<string, unknown> : {}), preset: "compact" })), false);
    assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath, "utf-8")), { theme: "dark" });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("getPromptHistoryText preserves multiline prompt text", () => {
  assert.equal(getPromptHistoryText("  line 1\nline 2  "), "line 1\nline 2");
  assert.equal(getPromptHistoryText([
    { type: "text", text: "  first line\nsecond line  " },
    { type: "text", text: "third line" },
  ]), "first line\nsecond line\nthird line");
});

test("readRecentProjectPrompts keeps reading legacy Pi session directories", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  writeFileSync(join(legacySessionsPath, "session.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "user", content: "legacy prompt", timestamp: 123 },
  }) + "\n");

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["legacy prompt"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts reads current hashed Pi session directories", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const sessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${projectStorageKey(cwd)}--`);

  process.env.HOME = homeDir;
  mkdirSync(sessionsPath, { recursive: true });
  writeFileSync(join(sessionsPath, "session.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "user", content: "hashed prompt", timestamp: 123 },
  }) + "\n");

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["hashed prompt"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts reads valid formatted JSONL", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  writeFileSync(join(legacySessionsPath, "session.jsonl"), '{"type": "message", "message": {"role": "user", "content": "formatted prompt", "timestamp": 123}}\n');

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["formatted prompt"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts orders string entry timestamps", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const sessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${projectStorageKey(cwd)}--`);

  process.env.HOME = homeDir;
  mkdirSync(sessionsPath, { recursive: true });
  writeFileSync(join(sessionsPath, "session.jsonl"), [
    JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "newer prompt" },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "older prompt", timestamp: 123 },
    }),
  ].join("\n") + "\n");

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["newer prompt", "older prompt"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts skips oversized session files", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  writeFileSync(join(legacySessionsPath, "oversized.jsonl"), "x".repeat(2 * 1024 * 1024 + 1));
  writeFileSync(join(legacySessionsPath, "small.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "user", content: "small prompt", timestamp: 123 },
  }) + "\n");

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["small prompt"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts applies file cap by newest session files", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  for (let i = 0; i < 200; i++) {
    writeFileSync(join(legacySessionsPath, `old-${i}.jsonl`), JSON.stringify({
      type: "message",
      message: { role: "user", content: `old ${i}`, timestamp: i },
    }) + "\n");
  }
  const newestPath = join(legacySessionsPath, "newest.jsonl");
  writeFileSync(newestPath, JSON.stringify({
    type: "message",
    message: { role: "user", content: "newest prompt", timestamp: 999 },
  }) + "\n");
  const future = new Date(Date.now() + 10_000);
  utimesSync(newestPath, future, future);

  try {
    assert.equal(readRecentProjectPrompts(cwd, 1)[0], "newest prompt");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts stops after total byte cap", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  const oldPath = join(legacySessionsPath, "old-readable.jsonl");
  writeFileSync(oldPath, JSON.stringify({
    type: "message",
    message: { role: "user", content: "old prompt", timestamp: 1 },
  }) + "\n");
  const oldDate = new Date(Date.now() - 10_000);
  utimesSync(oldPath, oldDate, oldDate);

  const largeContent = JSON.stringify({ type: "noop", pad: "x".repeat(2 * 1024 * 1024 - 128) }) + "\n";
  for (let i = 0; i < 9; i++) {
    const filePath = join(legacySessionsPath, `new-large-${i}.jsonl`);
    writeFileSync(filePath, largeContent);
    const future = new Date(Date.now() + 10_000 + i * 1000);
    utimesSync(filePath, future, future);
  }

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), []);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts skips symlinked session files and directories", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const targetDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent", "sessions"), { recursive: true });
  symlinkSync(targetDir, legacySessionsPath);
  writeFileSync(join(targetDir, "leaked.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "user", content: "leaked prompt", timestamp: 999 },
  }) + "\n");

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), []);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("stash history persists with private file permissions", async () => {
  const originalHome = process.env.HOME;
  const originalUmask = process.umask(0);
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const stashPath = join(homeDir, ".pi", "agent", "powerline-footer", "stash-history.json");
  const shortcuts = new Map<string, (ctx: any) => unknown>();

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });

  powerlineFooter({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut.handler);
    },
  } as any);

  try {
    const stashShortcut = shortcuts.get("alt+s");
    assert.ok(stashShortcut);

    await stashShortcut({
      hasUI: true,
      cwd,
      ui: {
        getEditorText: () => "secret draft",
        setEditorText() {},
        setStatus() {},
        notify() {},
      },
    });

    if (process.platform !== "win32") {
      assert.equal(statSync(stashPath).mode & 0o777, 0o600);
    }
  } finally {
    process.umask(originalUmask);
    process.env.HOME = originalHome;
  }
});

test("stash history refuses symlinked persistence files", async () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const stashDir = join(homeDir, ".pi", "agent", "powerline-footer");
  const targetPath = join(homeDir, "target-stash-history.json");
  const stashPath = join(stashDir, "stash-history.json");
  const shortcuts = new Map<string, (ctx: any) => unknown>();

  process.env.HOME = homeDir;
  mkdirSync(stashDir, { recursive: true });
  writeFileSync(targetPath, "keep\n");
  symlinkSync(targetPath, stashPath);

  powerlineFooter({
    on() {},
    registerCommand() {},
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut.handler);
    },
  } as any);

  try {
    const stashShortcut = shortcuts.get("alt+s");
    assert.ok(stashShortcut);

    await stashShortcut({
      hasUI: true,
      cwd,
      ui: {
        getEditorText: () => "do not overwrite target",
        setEditorText() {},
        setStatus() {},
        notify() {},
      },
    });

    assert.equal(readFileSync(targetPath, "utf-8"), "keep\n");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("stash history ignores oversized persistence files", async () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const stashDir = join(homeDir, ".pi", "agent", "powerline-footer");
  const stashPath = join(stashDir, "stash-history.json");
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const notifications: string[] = [];

  process.env.HOME = homeDir;
  mkdirSync(stashDir, { recursive: true });
  writeFileSync(stashPath, JSON.stringify({ history: ["hidden prompt".repeat(30000)] }) + "\n");

  powerlineFooter({
    on() {},
    registerShortcut() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, command.handler);
    },
  } as any);

  try {
    const handler = commands.get("stash-history");
    assert.ok(handler);

    await handler("", {
      hasUI: true,
      cwd,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    });

    assert.deepEqual(notifications, ["No prompt history yet"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts skips symlinked jsonl files", () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const targetPath = join(homeDir, "target-session.jsonl");
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  writeFileSync(targetPath, JSON.stringify({
    type: "message",
    message: { role: "user", content: "leaked prompt", timestamp: 999 },
  }) + "\n");
  symlinkSync(targetPath, join(legacySessionsPath, "linked.jsonl"));

  try {
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), []);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readRecentProjectPrompts skips unreadable session files without throwing", { skip: process.getuid?.() === 0 ? "cannot exercise EACCES as root" : false }, () => {
  const originalHome = process.env.HOME;
  const cwd = mkTempDir();
  const homeDir = mkTempDir();
  const legacyProjectKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-");
  const legacySessionsPath = join(homeDir, ".pi", "agent", "sessions", `--${legacyProjectKey}--`);

  process.env.HOME = homeDir;
  mkdirSync(legacySessionsPath, { recursive: true });
  writeFileSync(join(legacySessionsPath, "good.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "user", content: "readable prompt", timestamp: 1 },
  }) + "\n");
  const unreadablePath = join(legacySessionsPath, "unreadable.jsonl");
  writeFileSync(unreadablePath, JSON.stringify({
    type: "message",
    message: { role: "user", content: "hidden prompt", timestamp: 2 },
  }) + "\n");
  chmodSync(unreadablePath, 0o000);

  try {
    // A file that passes the lstat collection pass but cannot be read must be skipped,
    // not abort discovery of the other (readable) session files.
    assert.deepEqual(readRecentProjectPrompts(cwd, 10), ["readable prompt"]);
  } finally {
    chmodSync(unreadablePath, 0o600);
    process.env.HOME = originalHome;
  }
});

test("a shortcut remapped across sessions still routes its old key instead of dead-swallowing", async () => {
  // The host has no unregisterShortcut API and swallows any matched key, so a key
  // that a later session reload remaps away must keep routing to its last action
  // rather than becoming a dead key that silently eats input.
  const originalHome = process.env.HOME;
  const home = mkTempDir();
  const cwdA = mkTempDir();
  const cwdB = mkTempDir();

  process.env.HOME = home;
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwdA, ".pi"), { recursive: true });
  mkdirSync(join(cwdB, ".pi"), { recursive: true });
  writeFileSync(join(cwdA, ".pi", "settings.json"), JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+d" } }) + "\n");
  writeFileSync(join(cwdB, ".pi", "settings.json"), JSON.stringify({ powerlineShortcuts: { copyEditor: "ctrl+alt+e" } }) + "\n");

  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  // Mimic the host registry: keyed by shortcut string, retains every key ever
  // registered (the real host never removes them).
  const shortcuts = new Map<string, { handler: (ctx: any) => unknown }>();

  powerlineFooter({
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => unknown }) {
      shortcuts.set(key, shortcut);
    },
  } as any);

  try {
    await handlers.get("session_start")?.[0]?.({ reason: "resume" }, { cwd: cwdA, hasUI: false });
    assert.equal(shortcuts.has("ctrl+alt+d"), true);

    // Reload into project B: copyEditor moves to ctrl+alt+e, abandoning ctrl+alt+d.
    await handlers.get("session_start")?.[0]?.({ reason: "resume" }, { cwd: cwdB, hasUI: false });
    assert.equal(shortcuts.has("ctrl+alt+e"), true);
    assert.equal(shortcuts.has("ctrl+alt+d"), true);

    // Invoking the abandoned key must still route to copyEditor (observable via
    // the "Editor is empty" notice on an empty editor), not no-op.
    const notices: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      ui: { getEditorText: () => "", notify: (m: string, level: string) => notices.push([m, level]) },
    };
    await shortcuts.get("ctrl+alt+d")?.handler?.(ctx as any);
    assert.deepEqual(notices, [["Editor is empty", "info"]]);
  } finally {
    process.env.HOME = originalHome;
  }
});

function mkTempDir(): string {
  return mkdtempSync(join(tmpdir(), "powerline-footer-settings-"));
}

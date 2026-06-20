import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { appendProjectHistory, matchHistoryEntries, readGlobalShellHistory, readProjectHistory } from "../bash-mode/history.ts";
import { BASH_TRANSCRIPT_MAX_BYTES, BASH_TRANSCRIPT_MAX_LINES, BashTranscriptStore } from "../bash-mode/transcript.ts";
import {
  BashAutocompleteProvider,
  BashCompletionEngine,
  getOneOffBashCommandContext,
  ModeAwareAutocompleteProvider,
  OneOffBashAutocompleteProvider,
} from "../bash-mode/completion.ts";
import { getIcons } from "../icons.ts";
import { ManagedShellSession } from "../bash-mode/shell-session.ts";
import { projectStorageKey } from "../project-key.ts";
import { mightChangeGitBranch } from "../index.ts";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
const completionSource = readFileSync(new URL("../bash-mode/completion.ts", import.meta.url), "utf-8");

function getMethod(target: object, name: string): Function {
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    throw new Error(`Expected ${name} to be a function`);
  }
  return method;
}

function quoteForTestShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isProcessAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const managedShellPath = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";

function runGitForTest(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function setHistoryEnv(homeDir: string, histfile: string): () => void {
  const originalHome = process.env.HOME;
  const originalHistfile = process.env.HISTFILE;
  process.env.HOME = homeDir;
  process.env.HISTFILE = histfile;
  return () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalHistfile === undefined) {
      delete process.env.HISTFILE;
    } else {
      process.env.HISTFILE = originalHistfile;
    }
  };
}

function ensureEditorModuleLinks(): { cleanup: () => void } {
  const nodeModulesDir = join(process.cwd(), "node_modules", "@earendil-works");
  const requiredModules = ["pi-coding-agent", "pi-tui"];
  const missing = requiredModules.filter((name) => !existsSync(join(nodeModulesDir, name)));
  assert.deepEqual(
    missing,
    [],
    `Missing test dependencies: ${missing.join(", ")}. Run npm ci before running editor integration tests.`,
  );

  return { cleanup() {} };
}

test("project history is stored newest-first and global zsh history parses histfile format", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);

  appendProjectHistory(cwd, "git status", cwd);
  appendProjectHistory(cwd, "git stash", cwd);
  appendProjectHistory(cwd, "git status", cwd);

  writeFileSync(histfile, [
    ": 1711111111:0;git fetch",
    ": 1711111112:0;git pull",
    "plain-command",
    "",
  ].join("\n"));

  try {
    const global = readGlobalShellHistory("/bin/zsh");
    assert.deepEqual(global, ["plain-command", "git pull", "git fetch"]);
  } finally {
    restoreEnv();
  }
});

test("project history skips commands that contain obvious secrets", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-secret-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-secret-"));

  process.env.HOME = homeDir;
  try {
    appendProjectHistory(cwd, "git status", cwd);
    appendProjectHistory(cwd, "curl -H 'Authorization: Bearer abcdef123456' https://example.test", cwd);
    appendProjectHistory(cwd, "API_KEY=secret npm test", cwd);
    appendProjectHistory(cwd, "DB_PASS=secret psql", cwd);
    appendProjectHistory(cwd, "deploy --password hunter2", cwd);
    appendProjectHistory(cwd, "curl -u user:secret https://example.test", cwd);
    appendProjectHistory(cwd, "curl --user user:secret https://example.test", cwd);

    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git status"]);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("project history filters older persisted commands that contain secrets", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-secret-read-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-secret-read-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const historyPath = join(historyDir, `${projectStorageKey(cwd)}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({
    version: 1,
    entries: [
      { command: "git status", cwd, timestamp: 200 },
      { command: "curl https://user:secret@example.test", cwd, timestamp: 100 },
    ],
  }) + "\n");

  try {
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git status"]);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("project history storage separates paths that shared the old slug", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-home-"));
  const root = mkdtempSync(join(tmpdir(), "powerline-history-collision-"));
  const cwdA = join(root, "a-b");
  const cwdB = join(root, "a", "b");

  process.env.HOME = homeDir;
  appendProjectHistory(cwdA, "git status", cwdA);
  appendProjectHistory(cwdB, "git stash", cwdB);

  try {
    assert.deepEqual(readProjectHistory(cwdA).map((entry) => entry.command), ["git status"]);
    assert.deepEqual(readProjectHistory(cwdB).map((entry) => entry.command), ["git stash"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("project history keeps zero timestamps", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-zero-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-zero-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const newPath = join(historyDir, `${projectStorageKey(cwd)}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(newPath, JSON.stringify({
    version: 1,
    entries: [{ command: "git pull", cwd, timestamp: 0 }],
  }) + "\n");

  try {
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git pull"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("project history reads legacy slug files", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-legacy-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-legacy-"));
  const legacyKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-") || "root";
  const legacyPath = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history", `${legacyKey}.json`);

  process.env.HOME = homeDir;
  mkdirSync(join(homeDir, ".pi", "agent", "powerline-footer", "bash-history"), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    entries: [{ command: "git pull", cwd, timestamp: 123 }],
  }) + "\n");

  try {
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git pull"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("project history merges valid new and legacy files", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-merge-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-merge-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const legacyKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-") || "root";
  const legacyPath = join(historyDir, `${legacyKey}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    entries: [
      { command: "git pull", cwd, timestamp: 100 },
      { command: "git status", cwd, timestamp: 90 },
    ],
  }) + "\n");
  appendProjectHistory(cwd, "git status", cwd);

  try {
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git status", "git pull"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("project history falls back to legacy files when new file is malformed", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-malformed-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-malformed-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const legacyKey = cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-") || "root";
  const newPath = join(historyDir, `${projectStorageKey(cwd)}.json`);
  const legacyPath = join(historyDir, `${legacyKey}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(newPath, "not json\n");
  writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    entries: [{ command: "git pull", cwd, timestamp: 100 }],
  }) + "\n");

  try {
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git pull"]);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("project history ignores oversized files and replaces them on append", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-oversized-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-oversized-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const historyPath = join(historyDir, `${projectStorageKey(cwd)}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(historyPath, `${" ".repeat(300 * 1024)}`);

  try {
    assert.deepEqual(readProjectHistory(cwd), []);
    appendProjectHistory(cwd, "git status", cwd);
    assert.deepEqual(readProjectHistory(cwd).map((entry) => entry.command), ["git status"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(historyPath).mode & 0o777, 0o600);
    }
  } finally {
    process.env.HOME = originalHome;
  }
});

test("global shell history detects Windows-style shell paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-path-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "git status\n");

  try {
    const windowsPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const history = readGlobalShellHistory(windowsPath);

    assert.deepEqual(history, ["git status"]);
  } finally {
    restoreEnv();
  }
});

test("bash history preserves multiline commands instead of fragmenting them", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-history-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    "git status",
    "printf 'hello \\",
    "world'",
    "echo done",
    "",
  ].join("\n"));

  try {
    const history = readGlobalShellHistory("/bin/bash");
    assert.deepEqual(history, ["echo done", "printf 'hello\nworld'", "git status"]);
  } finally {
    restoreEnv();
  }
});

test("bash history preserves blank lines inside quoted commands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-history-blank-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    "printf 'hello",
    "",
    "world'",
    "echo done",
    "",
  ].join("\n"));

  try {
    const history = readGlobalShellHistory("/bin/bash");
    assert.deepEqual(history, ["echo done", "printf 'hello\n\nworld'"]);
  } finally {
    restoreEnv();
  }
});

test("global shell history caches unchanged files and invalidates on change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-history-cache-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ["git status", "ls -la", ""].join("\n"));

  try {
    const first = readGlobalShellHistory("/bin/bash");
    const second = readGlobalShellHistory("/bin/bash");
    // Unchanged file must serve the memoized array (a cache hit), not re-parse.
    assert.strictEqual(second, first, "expected cached array reference on unchanged file");
    assert.deepEqual(first, ["ls -la", "git status"]);

    // A content change alters the fingerprint and must invalidate the cache.
    writeFileSync(histfile, ["git status", "ls -la", "echo done", ""].join("\n"));
    const third = readGlobalShellHistory("/bin/bash");
    assert.notStrictEqual(third, first, "expected cache to invalidate after file change");
    assert.deepEqual(third, ["echo done", "ls -la", "git status"]);
  } finally {
    restoreEnv();
  }
});

test("bash history joins backslash continuations outside quotes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-history-continuation-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    "echo foo \\",
    "bar",
    "echo done",
    "",
  ].join("\n"));

  try {
    const history = readGlobalShellHistory("/bin/bash");
    assert.deepEqual(history, ["echo done", "echo foo\nbar"]);
  } finally {
    restoreEnv();
  }
});

test("bash history treats trailing backslashes as continuations", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-history-backslash-"));
  const histfile = join(cwd, ".bash_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    "echo literal \\",
    "next-command",
    "",
  ].join("\n"));

  try {
    const history = readGlobalShellHistory("/bin/bash");
    assert.deepEqual(history, ["echo literal\nnext-command"]);
  } finally {
    restoreEnv();
  }
});

test("matchHistoryEntries returns newest entries when the prefix is empty", () => {
  const matches = matchHistoryEntries([
    "git stash",
    "git status",
    "git stash",
    "git fetch",
  ], "", 10);

  assert.deepEqual(matches, ["git stash", "git status", "git fetch"]);
});

test("matchHistoryEntries skips commands that contain obvious secrets", () => {
  const matches = matchHistoryEntries([
    "curl -H 'Authorization: Bearer abcdef123456' https://example.test",
    "git -c http.extraHeader=Authorization\\:Bearer\\ abcdef123456 fetch",
    "compass=west echo ok",
    "API_TOKEN=secret npm test",
    "DB_PASS=secret psql",
    "curl -u user:secret https://example.test",
    "git status",
  ], "", 5);

  assert.deepEqual(matches, ["compass=west echo ok", "git status"]);
});

test("theme.json can override icons without touching colors", () => {
  const themePath = join(process.cwd(), "theme.json");
  const originalTheme = existsSync(themePath) ? readFileSync(themePath, "utf8") : null;
  const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;

  try {
    writeFileSync(themePath, JSON.stringify({ icons: { auto: "↯", warning: "" } }, null, 2) + "\n");
    delete process.env.POWERLINE_NERD_FONTS;

    const icons = getIcons();
    assert.equal(icons.auto, "↯");
    assert.equal(icons.warning, "");
    assert.equal(icons.folder, "");
  } finally {
    if (originalTheme === null) {
      if (existsSync(themePath)) unlinkSync(themePath);
    } else {
      writeFileSync(themePath, originalTheme);
    }

    if (originalNerdFonts === undefined) {
      delete process.env.POWERLINE_NERD_FONTS;
    } else {
      process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
    }
  }
});

test("one-off bash command context strips ! and !! prefixes", () => {
  assert.deepEqual(getOneOffBashCommandContext("!git status"), {
    prefix: "!",
    command: "git status",
    offset: 1,
  });

  assert.deepEqual(getOneOffBashCommandContext("!!git status"), {
    prefix: "!!",
    command: "git status",
    offset: 2,
  });

  assert.equal(getOneOffBashCommandContext("  !!git status"), null);
  assert.equal(getOneOffBashCommandContext("git status"), null);
});

test("one-off bash ghost suggestions strip and restore bang prefixes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-one-off-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");
  appendProjectHistory(cwd, "git status", cwd);

  try {
    const oneOffBash = getOneOffBashCommandContext("!!git st");
    assert.ok(oneOffBash);

    const engine = new BashCompletionEngine();
    const ghost = await engine.getGhostSuggestion(
      oneOffBash.command,
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(ghost?.value, "git status");
    assert.equal(`${oneOffBash.prefix}${ghost?.value}`, "!!git status");
    assert.match(indexSource, /const oneOffBash = getOneOffBashCommandContext\(text\);/);
    assert.match(indexSource, /return ghost \? \{ \.\.\.ghost, value: `\$\{oneOffBash\.prefix\}\$\{ghost\.value\}` \} : null;/);
  } finally {
    restoreEnv();
  }
});

test("transcript store truncates oldest commands at command boundaries", () => {
  const store = new BashTranscriptStore({ transcriptMaxLines: 3, transcriptMaxBytes: 1024 });
  store.startCommand("a", "echo one", "/tmp");
  store.appendOutput("a", "line-1\nline-2");
  store.finishCommand("a", 0);

  store.startCommand("b", "echo two", "/tmp");
  store.appendOutput("b", "line-3\nline-4");
  store.finishCommand("b", 0);

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]?.id, "b");
  assert.equal(snapshot.truncatedCommands, 1);
});

test("transcript store strips terminal controls from commands and output", () => {
  const store = new BashTranscriptStore({ transcriptMaxLines: 10, transcriptMaxBytes: 1024 });
  store.startCommand("a", "echo \x1b]52;c;secret\x07safe", "/tmp/\x1b[31mrepo");
  store.appendOutput("a", "before\x1b]52;c;secret\x07after\x1b[2J");

  const command = store.getSnapshot().commands[0];
  assert.equal(command?.command, "echo safe");
  assert.equal(command?.cwdAtStart, "/tmp/repo");
  assert.deepEqual(command?.output, ["beforeafter"]);
});

test("transcript store keeps the active command even when it alone exceeds limits", () => {
  const store = new BashTranscriptStore({ transcriptMaxLines: 3, transcriptMaxBytes: 1024 });
  store.startCommand("a", "echo big", "/tmp");
  store.appendOutput("a", "1\n2\n3\n4");

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]?.id, "a");
  assert.deepEqual(snapshot.commands[0]?.output, ["2", "3", "4"]);
  assert.equal(snapshot.commands[0]?.truncated, true);
  assert.equal(snapshot.totalLines, 3);
});

test("transcript store caps a single oversized output line", () => {
  const store = new BashTranscriptStore({ transcriptMaxLines: 10, transcriptMaxBytes: 6 });
  store.startCommand("a", "echo big", "/tmp");
  store.appendOutput("a", "1234567890");

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]?.id, "a");
  assert.equal(snapshot.commands[0]?.output[0], "67890");
  assert.equal(snapshot.commands[0]?.truncated, true);
  assert.equal(snapshot.totalBytes, 6);
});

test("transcript store does not split a surrogate pair when trimming an oversized line", () => {
  const store = new BashTranscriptStore({ transcriptMaxLines: 10, transcriptMaxBytes: 14 });
  store.startCommand("a", "echo emoji", "/tmp");
  // Five astral-plane emoji (4 UTF-8 bytes / 2 UTF-16 code units each). Trimming
  // by code-unit count would otherwise cut through a surrogate pair.
  store.appendOutput("a", "\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}");

  const snapshot = store.getSnapshot();
  const trimmed = snapshot.commands[0]?.output[0] ?? "";
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(loneSurrogate.test(trimmed), false, "trimmed line must not contain a lone surrogate");
  assert.equal(snapshot.commands[0]?.truncated, true);
  assert.ok(Buffer.byteLength(trimmed, "utf8") <= 14, "trimmed line must respect the byte cap");
});

test("transcript store keeps the tail when trimming a large multibyte line", () => {
  // Cap of 40 bytes with a 400-byte line (100 astral emoji). The number of bytes
  // to remove (~360) exceeds the line's UTF-16 code-unit count (200), which is
  // exactly the case where treating a byte count as a slice offset discarded the
  // whole line. The trimmed line must instead retain the most recent emoji.
  const store = new BashTranscriptStore({ transcriptMaxLines: 10, transcriptMaxBytes: 40 });
  store.startCommand("a", "echo emoji", "/tmp");
  store.appendOutput("a", "\u{1F600}".repeat(100));

  const snapshot = store.getSnapshot();
  const trimmed = snapshot.commands[0]?.output[0] ?? "";
  assert.ok(trimmed.length > 0, "multibyte line must not be trimmed away entirely");
  assert.equal([...trimmed].every((ch) => ch === "\u{1F600}"), true);
  assert.ok(Buffer.byteLength(trimmed, "utf8") <= 40, "trimmed line must respect the byte cap");
  assert.equal(snapshot.commands[0]?.truncated, true);
});

test("transcript store caps extremely large configured limits", () => {
  const store = new BashTranscriptStore({
    transcriptMaxLines: Number.MAX_SAFE_INTEGER,
    transcriptMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  store.startCommand("a", "yes", "/tmp");
  store.appendOutput(
    "a",
    Array.from({ length: BASH_TRANSCRIPT_MAX_LINES + 5 }, (_, index) => `line-${index}`).join("\n"),
  );

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.totalLines, BASH_TRANSCRIPT_MAX_LINES);
  assert.equal(snapshot.commands[0]?.output[0], "line-5");
  assert.equal(snapshot.commands[0]?.truncated, true);
});

test("transcript store caps a single line when configured byte limits are huge", () => {
  const store = new BashTranscriptStore({
    transcriptMaxLines: Number.MAX_SAFE_INTEGER,
    transcriptMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  store.startCommand("a", "yes", "/tmp");
  store.appendOutput("a", "x".repeat(BASH_TRANSCRIPT_MAX_BYTES + 16));

  const snapshot = store.getSnapshot();
  const line = snapshot.commands[0]?.output[0] ?? "";
  assert.equal(snapshot.totalBytes, BASH_TRANSCRIPT_MAX_BYTES);
  assert.equal(Buffer.byteLength(line, "utf8"), BASH_TRANSCRIPT_MAX_BYTES - 1);
  assert.equal(snapshot.commands[0]?.truncated, true);
});

test("project history refuses symlinked cache files", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-symlink-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-symlink-cwd-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  const targetPath = join(homeDir, "target-history.json");
  const historyPath = join(historyDir, `${projectStorageKey(cwd)}.json`);

  process.env.HOME = homeDir;
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(targetPath, "keep\n");
  symlinkSync(targetPath, historyPath);

  try {
    appendProjectHistory(cwd, "git status", cwd);

    assert.equal(readFileSync(targetPath, "utf8"), "keep\n");
    assert.deepEqual(readProjectHistory(cwd), []);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("global shell history ignores unsafe HISTFILE paths", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-safe-history-home-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "powerline-unsafe-history-"));
  const histfile = join(outsideDir, ".zsh_history");
  const restoreEnv = setHistoryEnv(homeDir, histfile);
  writeFileSync(histfile, ": 1711111111:0;git secret\n");

  try {
    assert.deepEqual(readGlobalShellHistory("/bin/zsh"), []);
  } finally {
    restoreEnv();
  }
});

test("global shell history ignores symlinked HISTFILE paths", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-safe-history-link-home-"));
  const targetDir = join(homeDir, "target");
  const targetPath = join(targetDir, ".zsh_history");
  const histfile = join(homeDir, ".zsh_history");
  const restoreEnv = setHistoryEnv(homeDir, histfile);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, ": 1711111111:0;git secret\n");
  symlinkSync(targetPath, histfile);

  try {
    assert.deepEqual(readGlobalShellHistory("/bin/zsh"), []);
  } finally {
    restoreEnv();
  }
});

test("global shell history reads custom HISTFILE names inside home", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-safe-history-name-home-"));
  const histfile = join(homeDir, ".cache", "custom-zsh-history");
  const restoreEnv = setHistoryEnv(homeDir, histfile);
  mkdirSync(join(homeDir, ".cache"), { recursive: true });
  writeFileSync(histfile, ": 1711111111:0;git switch\n");

  try {
    assert.deepEqual(readGlobalShellHistory("/bin/zsh"), ["git switch"]);
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion prefers project history over global history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ": 1711111111:0;git switch\n");
  appendProjectHistory(cwd, "git status", cwd);
  appendProjectHistory(cwd, "git stash", cwd);

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "git st",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git stash");
    assert.equal(suggestion?.source, "project-history");
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion shows newest project history on an empty prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-empty-project-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ": 1711111111:0;git pull\n");
  appendProjectHistory(cwd, "git status", cwd);
  appendProjectHistory(cwd, "git stash", cwd);

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git stash");
    assert.equal(suggestion?.source, "project-history");
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion stays empty on an empty prompt when only global history exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-empty-global-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    ": 1711111111:0;git fetch",
    ": 1711111112:0;git pull",
  ].join("\n"));

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion, null);
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion stays empty when the prompt is empty and no history exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-empty-no-history-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion, null);
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion can extend the current token from deterministic path completions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-inline-ghost-"));
  mkdirSync(join(cwd, "dev"), { recursive: true });
  mkdirSync(join(cwd, "My Folder"), { recursive: true });

  const engine = new BashCompletionEngine();
  const suggestion = await engine.getGhostSuggestion(
    "cd d",
    cwd,
    "/bin/sh",
    new AbortController().signal,
  );
  const escapedSuggestion = await engine.getGhostSuggestion(
    "cd M",
    cwd,
    "/bin/sh",
    new AbortController().signal,
  );

  assert.equal(suggestion?.value, "cd dev/");
  assert.equal(suggestion?.source, "path");
  assert.equal(escapedSuggestion?.value, "cd My\\ Folder/");
  assert.equal(escapedSuggestion?.source, "path");
});

test("deterministic path completions use bounded streaming directory scans", async () => {
  assert.match(completionSource, /opendirSync\(dir\)/);
  assert.doesNotMatch(completionSource, /readdirSync\(dir/);

  const cwd = mkdtempSync(join(tmpdir(), "powerline-path-cap-"));
  for (let i = 0; i < 150; i++) {
    mkdirSync(join(cwd, `p${String(i).padStart(3, "0")}`), { recursive: true });
  }

  const engine = new BashCompletionEngine();
  const getDeterministicInlineSuggestions = getMethod(engine, "getDeterministicInlineSuggestions");
  const items = await getDeterministicInlineSuggestions.call(engine, {
    line: "cd p",
    cursorCol: 4,
    beforeCursor: "cd p",
    afterCursor: "",
    token: "p",
    tokenStart: 3,
    tokenEnd: 4,
    tokenIndex: 1,
    previousTokens: ["cd"],
  }, cwd);

  assert.equal(items.filter((item: { source?: string }) => item.source === "path").length, 100);
});

test("ghost suggestion does not invoke shell-native completion hooks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-no-native-ghost-"));
  mkdirSync(join(cwd, "dev"), { recursive: true });

  const engine = new BashCompletionEngine();
  Reflect.set(engine, "getNativeSuggestions", async () => {
    throw new Error("native completion should stay disabled");
  });

  const suggestion = await engine.getGhostSuggestion(
    "cd d",
    cwd,
    "/bin/zsh",
    new AbortController().signal,
  );

  assert.equal(suggestion?.value, "cd dev/");
  assert.equal(suggestion?.source, "path");
});

test("command-position ghost prefers the newest successful project-history command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-project-history-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");
  appendProjectHistory(cwd, "git status", cwd);

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "g",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git status");
    assert.equal(suggestion?.source, "project-history");
  } finally {
    restoreEnv();
  }
});

test("command-position ghost uses guarded global git history when project history is absent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-global-history-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ": 1711111111:0;git stash\n");

  try {
    const engine = new BashCompletionEngine();
    const shortStemSuggestion = await engine.getGhostSuggestion(
      "g",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );
    const guardedSuggestion = await engine.getGhostSuggestion(
      "gi",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(shortStemSuggestion?.value, "git status");
    assert.equal(shortStemSuggestion?.source, "git");
    assert.equal(guardedSuggestion?.value, "git stash");
    assert.equal(guardedSuggestion?.source, "global-history");
  } finally {
    restoreEnv();
  }
});

test("command-position ghost skips secret-bearing global git history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-global-secret-history-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, [
    ": 1711111111:0;git status",
    ": 1711111112:0;git -c http.extraHeader='Authorization: Bearer abcdef123456' fetch",
    ": 1711111113:0;git -c http.extraHeader=Authorization\\:Bearer\\ abcdef123456 fetch",
    "",
  ].join("\n"));

  try {
    const suggestion = await new BashCompletionEngine().getGhostSuggestion(
      "gi",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git status");
    assert.equal(suggestion?.source, "global-history");
  } finally {
    restoreEnv();
  }
});

test("command-position ghost falls back to git status when git is likely but history is absent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-git-default-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "g",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git status");
    assert.equal(suggestion?.source, "git");
  } finally {
    restoreEnv();
  }
});

test("command-position ghost falls back to cd dot-dot for the cd stem", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-cd-default-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "c",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "cd ..");
    assert.equal(suggestion?.source, "path");
  } finally {
    restoreEnv();
  }
});

test("command-position ghost stays empty when there is no supported history-backed stem", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-command-empty-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "x",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion, null);
  } finally {
    restoreEnv();
  }
});

test("ghost suggestion ignores invalid raw global history and keeps a deterministic git candidate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-global-history-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ": 1711111111:0;git statis\n");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "git st",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.match(suggestion?.value ?? "", /^git sta(?:sh|tus)$/);
    assert.equal(suggestion?.source, "git");
  } finally {
    restoreEnv();
  }
});

test("global history boosts already-valid deterministic git candidates", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-global-history-tiebreak-ghost-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, ": 1711111111:0;git stash\n");

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "git st",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git stash");
    assert.equal(suggestion?.source, "git");
  } finally {
    restoreEnv();
  }
});

test("git ref ghost suggestions handle an empty argument after trailing space", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-git-ref-ghost-"));
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-git-ref-home-"));
  const restoreEnv = setHistoryEnv(homeDir, join(homeDir, ".bash_history"));

  try {
    runGitForTest(cwd, ["init", "-b", "main"]);
    writeFileSync(join(cwd, "file.txt"), "x\n");
    runGitForTest(cwd, ["add", "file.txt"]);
    runGitForTest(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    runGitForTest(cwd, ["branch", "aaa-target"]);

    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "git checkout ",
      cwd,
      "/bin/bash",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "git checkout aaa-target");
    assert.equal(suggestion?.source, "git");
  } finally {
    restoreEnv();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("git ref ghost suggestions shell-escape metacharacters", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-git-ref-escape-"));
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-git-ref-escape-home-"));
  const restoreEnv = setHistoryEnv(homeDir, join(homeDir, ".bash_history"));

  try {
    runGitForTest(cwd, ["init", "-b", "main"]);
    writeFileSync(join(cwd, "file.txt"), "x\n");
    runGitForTest(cwd, ["add", "file.txt"]);
    runGitForTest(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    runGitForTest(cwd, ["branch", "feature$one"]);
    runGitForTest(cwd, ["branch", "#danger"]);
    runGitForTest(cwd, ["update-ref", "refs/heads/-Bfoo", "HEAD"]);
    runGitForTest(cwd, ["tag", "v;danger"]);

    const engine = new BashCompletionEngine();
    assert.equal(
      (await engine.getGhostSuggestion("git checkout f", cwd, "/bin/bash", new AbortController().signal))?.value,
      "git checkout feature\\$one",
    );
    assert.equal(
      (await engine.getGhostSuggestion("git checkout feature\\$", cwd, "/bin/bash", new AbortController().signal))?.value,
      "git checkout feature\\$one",
    );
    assert.equal(
      (await engine.getGhostSuggestion("git checkout \\#", cwd, "/bin/bash", new AbortController().signal))?.value,
      "git checkout \\#danger",
    );
    assert.equal(
      await engine.getGhostSuggestion("git checkout -", cwd, "/bin/bash", new AbortController().signal),
      null,
    );
    assert.equal(
      (await engine.getGhostSuggestion("git checkout v", cwd, "/bin/bash", new AbortController().signal))?.value,
      "git checkout v\\;danger",
    );
  } finally {
    restoreEnv();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("deterministic path completion keeps directory suffixes for escaped paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-path-escaped-"));
  const histfile = join(cwd, ".zsh_history");
  const restoreEnv = setHistoryEnv(cwd, histfile);
  writeFileSync(histfile, "");
  mkdirSync(join(cwd, "My Folder"), { recursive: true });

  try {
    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "cd M",
      cwd,
      "/bin/zsh",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "cd My\\ Folder/");
    assert.equal(suggestion?.source, "path");
  } finally {
    restoreEnv();
  }
});

test("deterministic path completion handles bash argument position", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-path-"));
  mkdirSync(join(cwd, "devdir"), { recursive: true });

  const engine = new BashCompletionEngine();
  const suggestion = await engine.getGhostSuggestion(
    "cd d",
    cwd,
    "/bin/bash",
    new AbortController().signal,
  );

  assert.equal(suggestion?.value, "cd devdir/");
  assert.equal(suggestion?.source, "path");
});

test("deterministic path completion handles escaped and quoted spaces", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-path-spaces-"));
  mkdirSync(join(cwd, "My Folder", "Child Dir"), { recursive: true });

  const engine = new BashCompletionEngine();
  const signal = new AbortController().signal;

  assert.equal(
    (await engine.getGhostSuggestion("cd My\\ F", cwd, "/bin/bash", signal))?.value,
    "cd My\\ Folder/",
  );
  assert.equal(
    (await engine.getGhostSuggestion('cd "My F', cwd, "/bin/bash", signal))?.value,
    'cd "My Folder/',
  );
  assert.equal(
    (await engine.getGhostSuggestion('cd "My Folder/C', cwd, "/bin/bash", signal))?.value,
    'cd "My Folder/Child Dir/',
  );
});

test("quoted tilde path completion stays relative to cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-quoted-tilde-"));
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-bash-quoted-tilde-home-"));
  const restoreEnv = setHistoryEnv(homeDir, join(homeDir, ".bash_history"));
  mkdirSync(join(homeDir, "HomeDir"), { recursive: true });

  try {
    const engine = new BashCompletionEngine();
    const signal = new AbortController().signal;
    assert.equal(
      (await engine.getGhostSuggestion("cd ~/H", cwd, "/bin/bash", signal))?.value,
      "cd ~/HomeDir/",
    );
    assert.equal(await engine.getGhostSuggestion('cd "~/H', cwd, "/bin/bash", signal), null);
  } finally {
    restoreEnv();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("tilde path completion falls back when HOME is unset", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-tilde-no-home-"));
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-bash-tilde-userprofile-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  mkdirSync(join(homeDir, "HomeDir"), { recursive: true });

  try {
    delete process.env.HOME;
    process.env.USERPROFILE = homeDir;

    const engine = new BashCompletionEngine();
    const suggestion = await engine.getGhostSuggestion(
      "cd ~/H",
      cwd,
      "/bin/bash",
      new AbortController().signal,
    );

    assert.equal(suggestion?.value, "cd ~/HomeDir/");
    assert.equal(suggestion?.source, "path");

    const homeRootSuggestion = await engine.getGhostSuggestion(
      "cd ~/",
      cwd,
      "/bin/bash",
      new AbortController().signal,
    );

    assert.equal(homeRootSuggestion?.value, "cd ~/HomeDir/");
    assert.equal(homeRootSuggestion?.source, "path");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("git ref ghost suggestions return promptly when git hangs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-git-hang-"));
  const binDir = join(cwd, "bin");
  mkdirSync(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, "#!/bin/sh\ntrap '' TERM\nsleep 2\n", "utf8");
  chmodSync(gitPath, 0o700);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  try {
    const startedAt = Date.now();
    const suggestion = await new BashCompletionEngine().getGhostSuggestion(
      "git checkout m",
      cwd,
      "/bin/bash",
      new AbortController().signal,
    );
    assert.equal(suggestion, null);
    assert.ok(Date.now() - startedAt < 1500, "git completion should time out quickly");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("git ref ghost suggestions abort pending git processes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-git-abort-"));
  const binDir = join(cwd, "bin");
  const pidPath = join(cwd, "git.pid");
  mkdirSync(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh
trap '' TERM
echo $$ > ${quoteForTestShell(pidPath)}
sleep 2
`, "utf8");
  chmodSync(gitPath, 0o700);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  let gitPid = 0;
  try {
    const controller = new AbortController();
    const pending = new BashCompletionEngine().getGhostSuggestion("git checkout m", cwd, "/bin/bash", controller.signal);
    const pidDeadline = Date.now() + 500;
    while (Date.now() < pidDeadline && gitPid === 0) {
      try {
        gitPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10) || 0;
      } catch {
        // Wait until the fake git process records its PID.
      }
      if (gitPid === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(gitPid > 0, "expected fake git process to start");

    const abortStartedAt = Date.now();
    controller.abort();
    assert.equal(await pending, null);
    assert.ok(Date.now() - abortStartedAt < 300, "aborted git completion should not wait for its timeout");

    const killDeadline = Date.now() + 500;
    while (Date.now() < killDeadline && isProcessAliveForTest(gitPid)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isProcessAliveForTest(gitPid), false, "aborted git completion should kill its git process");
  } finally {
    if (gitPid > 0 && isProcessAliveForTest(gitPid)) {
      try {
        process.kill(gitPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("managed shell session preserves cwd changes across commands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-"));
  const childDir = join(cwd, "child:with:colon");
  mkdirSync(childDir, { recursive: true });
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    await session.ensureReady();
    await session.runCommand(`cd ${childDir}`);
    const waitForCommand = async () => {
      const start = Date.now();
      while (session.state.running && Date.now() - start < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(session.state.running, false);
    };

    await waitForCommand();
    assert.equal(session.state.cwd, childDir);

    await session.runCommand("pwd");
    await waitForCommand();

    const snapshot = store.getSnapshot();
    const lastCommand = snapshot.commands[snapshot.commands.length - 1];
    assert.ok(lastCommand?.output.includes(childDir));
  } finally {
    session.dispose();
  }
});

test("managed shell session calls completion hook for command exits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-complete-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const completions: Array<{ command: string; cwd: string; exitCode: number }> = [];
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {}, {
    onCommandComplete: (command, completedCwd, exitCode) => {
      completions.push({ command, cwd: completedCwd, exitCode });
    },
  });

  const waitForCompletion = async (count: number) => {
    const start = Date.now();
    while ((session.state.running || completions.length < count) && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
    assert.equal(completions.length, count);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf 'ok\\n'");
    await waitForCompletion(1);
    assert.equal(completions[0]?.command, "printf 'ok\\n'");
    assert.equal(realpathSync(completions[0]?.cwd ?? ""), realpathSync(cwd));
    assert.equal(completions[0]?.exitCode, 0);

    await session.runCommand("false");
    await waitForCompletion(2);
    assert.equal(completions[1]?.command, "false");
    assert.equal(completions[1]?.exitCode, 1);
  } finally {
    session.dispose();
  }
});

test("managed shell session calls completion hook when command closes shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-close-complete-"));
  const changedPath = join(cwd, "changed.txt");
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const completions: Array<{ command: string; cwd: string; exitCode: number }> = [];
  const session = new ManagedShellSession("/bin/sh", cwd, store, () => {}, () => {}, {
    onCommandComplete: (command, completedCwd, exitCode) => {
      completions.push({ command, cwd: completedCwd, exitCode });
    },
  });

  try {
    await session.ensureReady();
    await session.runCommand("exec sh -c 'touch changed.txt; exit 0'");

    const start = Date.now();
    while ((session.state.running || completions.length < 1) && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(session.state.running, false);
    assert.equal(existsSync(changedPath), true);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.command, "exec sh -c 'touch changed.txt; exit 0'");
    assert.equal(realpathSync(completions[0]?.cwd ?? ""), realpathSync(cwd));
    assert.equal(completions[0]?.exitCode, 0);
  } finally {
    session.dispose();
  }
});

test("managed bash command completion invalidates git state", () => {
  assert.match(indexSource, /onCommandComplete: \(\) => \{\n\s+invalidateGitStatus\(\);\n\s+invalidateGitBranch\(\);\n\s+\}/);
});

test("user bash commands invalidate dirty git state", () => {
  assert.match(indexSource, /const USER_BASH_REFRESH_DELAYS_MS = \[100, 300, 500, 1_000, 2_000, 5_000, 10_000, 30_000\] as const;/);
  assert.match(indexSource, /const cancelUserBashGitRefreshTimers = \(\) => \{[\s\S]*?clearTimeout\(timer\);/);
  assert.match(indexSource, /const scheduleUserBashGitRefresh = \(_command: string\): void => \{[\s\S]*?cancelUserBashGitRefreshTimers\(\);[\s\S]*?const refreshGeneration = sessionGeneration;[\s\S]*?const invalidate = \(\) => \{\n\s+invalidateGitStatus\(\);\n\s+invalidateGitBranch\(\);\n\s+\};[\s\S]*?setTimeout\(\(\) => invalidateAndRender\(timer\), delayMs\);/);
  assert.match(indexSource, /pi\.on\("user_bash", async \(event\) => \{\n\s+scheduleUserBashGitRefresh\(event\.command\);\n\s+\}\);/);
});

test("git branch change detection skips global git options", () => {
  assert.equal(mightChangeGitBranch("git -C . switch feature"), true);
  assert.equal(mightChangeGitBranch("git -c advice.detachedHead=false checkout main"), true);
  assert.equal(mightChangeGitBranch("git -P switch feature"), true);
  assert.equal(mightChangeGitBranch("git -p checkout main"), true);
  assert.equal(mightChangeGitBranch("git --work-tree=/tmp --git-dir=.git stash pop"), true);
  assert.equal(mightChangeGitBranch("git -C . branch -m old new"), true);
  assert.equal(mightChangeGitBranch("git branch --force --move old new"), true);
  assert.equal(mightChangeGitBranch("git -C . status"), false);
});

test("git branch change detection handles aliases conservatively", () => {
  assert.equal(mightChangeGitBranch("git -c alias.co=checkout co main"), true);
  assert.equal(mightChangeGitBranch("git -c alias.sw=\"switch feature\" sw"), true);
  assert.equal(mightChangeGitBranch("git -c alias.b=branch b --force --move old new"), true);
  assert.equal(mightChangeGitBranch("git -c alias.g='!git' g switch main"), true);
  assert.equal(mightChangeGitBranch("git -c alias.lg=\"log --oneline\" lg"), false);
  assert.equal(mightChangeGitBranch("git -c alias.lg=\"!git log --oneline\" lg"), false);
  assert.equal(mightChangeGitBranch("shopt -s expand_aliases; alias co=\"git switch\"; co feature"), true);
  assert.equal(mightChangeGitBranch("alias gs=\"git status\"; gs"), false);
  assert.equal(mightChangeGitBranch("git co main"), true);
  assert.equal(mightChangeGitBranch("git add file.txt"), false);
});

test("git branch change detection sees grouped git commands", () => {
  assert.equal(mightChangeGitBranch("(git switch main)"), true);
  assert.equal(mightChangeGitBranch("foo=$(git switch main)"), true);
  assert.equal(mightChangeGitBranch("foo=$(git status)"), false);
});

test("managed shell session starts with POSIX sh fallback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-sh-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/sh", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    assert.equal(session.state.ready, true);
    assert.equal(realpathSync(session.state.cwd), realpathSync(cwd));

    await session.runCommand("printf 'sh-ok\\n'");
    await waitForCommand();
    assert.ok(store.getSnapshot().commands.at(-1)?.output.includes("sh-ok"));

    await session.runCommand("printf 'sh-still-ok\\n'");
    await waitForCommand();
    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.ok(lastCommand?.output.includes("sh-still-ok"));
    assert.equal(session.state.ready, true);
  } finally {
    session.dispose();
  }
});

test("managed shell session rejects when shell never becomes ready", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-never-ready-"));
  const shellPath = join(cwd, "never-ready.sh");
  writeFileSync(shellPath, "#!/bin/sh\nsleep 10\n", "utf8");
  chmodSync(shellPath, 0o700);
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(shellPath, cwd, store, () => {}, () => {}, { readyTimeoutMs: 50 });

  try {
    await assert.rejects(
      () => session.ensureReady(),
      /Shell did not become ready within 50ms/,
    );
    assert.equal(session.state.ready, false);
    assert.equal(session.state.running, false);
    await assert.rejects(
      () => session.ensureReady(),
      /Shell did not become ready within 50ms/,
    );
  } finally {
    session.dispose();
  }
});

test("managed shell session completes commands with no trailing output newline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-no-newline-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf 'partial'");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.ok(lastCommand?.output.includes("partial"));
  } finally {
    session.dispose();
  }
});

test("managed shell session caps newline-less stdout and stderr buffers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-buffer-cap-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "huge", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");

    const handleStdoutChunk = Reflect.get(session, "handleStdoutChunk") as (chunk: string) => void;
    handleStdoutChunk.call(session, "x".repeat(128 * 1024));
    assert.ok(Buffer.byteLength(Reflect.get(session, "stdoutBuffer") as string, "utf8") <= 64 * 1024);

    const handleStderrChunk = Reflect.get(session, "handleStderrChunk") as (chunk: string) => void;
    handleStderrChunk.call(session, "e".repeat(128 * 1024));
    assert.ok(Buffer.byteLength(Reflect.get(session, "stderrBuffer") as string, "utf8") <= 64 * 1024);

    const output = store.getSnapshot().commands[0]?.output.join("\n") ?? "";
    assert.match(output, /truncated before newline/);
  } finally {
    session.dispose();
  }
});

test("managed shell session keeps the tail of a capped multibyte stdout buffer", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-buffer-cap-mb-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "huge", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");

    // A long newline-less line of astral (4-byte) characters. The buffer cap must
    // retain the most recent ~64 KiB of output, not discard the whole line:
    // counting UTF-8 bytes as UTF-16 code-unit offsets previously emptied it.
    const handleStdoutChunk = Reflect.get(session, "handleStdoutChunk") as (chunk: string) => void;
    handleStdoutChunk.call(session, "\u{1F600}".repeat(40 * 1024));

    const buffer = Reflect.get(session, "stdoutBuffer") as string;
    const bufferBytes = Buffer.byteLength(buffer, "utf8");
    assert.ok(bufferBytes <= 64 * 1024, `buffer exceeded cap: ${bufferBytes}`);
    // The tail must survive: at least half the cap, and made of whole emoji.
    assert.ok(bufferBytes > 32 * 1024, `multibyte tail was over-trimmed: ${bufferBytes}`);
    assert.equal([...buffer].every((ch) => ch === "\u{1F600}"), true);
    assert.doesNotMatch(buffer, /\uFFFD/);
  } finally {
    session.dispose();
  }
});

test("managed shell session strips terminal controls split across stdout chunks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stream-controls-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    session.state.ready = true;
    store.startCommand("cmd-1", "controls", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");
    const handleStdoutChunk = Reflect.get(session, "handleStdoutChunk") as (chunk: string) => void;

    handleStdoutChunk.call(session, "\x1b[");
    handleStdoutChunk.call(session, "31mred\n");
    handleStdoutChunk.call(session, "\x1b]52;c;sec");
    handleStdoutChunk.call(session, "ret\x07visible\n");

    const output = (store.getSnapshot().commands[0]?.output ?? []).join("\n");
    assert.match(output, /red/);
    assert.match(output, /visible/);
    assert.doesNotMatch(output, /\[31m/);
    assert.doesNotMatch(output, /secret/);
    assert.doesNotMatch(output, /\]52/);
  } finally {
    session.dispose();
  }
});

test("managed shell session strips OSC controls spanning output lines", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-multiline-osc-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "multiline osc", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");
    Reflect.set(Reflect.get(session, "state"), "ready", true);

    const handleStdoutChunk = Reflect.get(session, "handleStdoutChunk") as (chunk: string) => void;
    handleStdoutChunk.call(session, "before\x1b]52;c;sec\nret\x07after\n");

    assert.deepEqual(store.getSnapshot().commands[0]?.output, ["beforeafter"]);
  } finally {
    session.dispose();
  }
});

test("managed shell session strips split OSC controls from stderr lines", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stderr-osc-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "stderr osc", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");

    const handleStderrChunk = Reflect.get(session, "handleStderrChunk") as (chunk: string) => void;
    handleStderrChunk.call(session, "before\x1b]52;c;sec");
    handleStderrChunk.call(session, "ret\x07after\n");

    assert.deepEqual(store.getSnapshot().commands[0]?.output, ["beforeafter"]);
  } finally {
    session.dispose();
  }
});

test("managed shell session recognizes split ST terminator before done sentinel", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-split-st-sentinel-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "split st", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");
    Reflect.set(session, "currentCommandNonce", "nonce");
    Reflect.set(Reflect.get(session, "state"), "ready", true);
    Reflect.set(Reflect.get(session, "state"), "running", true);

    const handleStdoutChunk = Reflect.get(session, "handleStdoutChunk") as (chunk: string) => void;
    handleStdoutChunk.call(session, "before\x1b]52;c;secret\x1b");
    handleStdoutChunk.call(session, `\\\n__PI_CMD_DONE__:nonce:cmd-1:0:${cwd}\n`);

    assert.equal(session.state.running, false);
    assert.equal(Reflect.get(session, "stdoutControlState"), "normal");
    assert.deepEqual(store.getSnapshot().commands[0]?.output, ["before"]);
  } finally {
    session.dispose();
  }
});

test("managed shell session strips stderr OSC when ST is split across chunks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stderr-split-st-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  try {
    store.startCommand("cmd-1", "stderr split st", cwd);
    Reflect.set(session, "currentCommandId", "cmd-1");

    const handleStderrChunk = Reflect.get(session, "handleStderrChunk") as (chunk: string) => void;
    handleStderrChunk.call(session, "before\x1b]52;c;secret\x1b");
    handleStderrChunk.call(session, "\\after\n");

    assert.equal(Reflect.get(session, "stderrControlState"), "normal");
    assert.deepEqual(store.getSnapshot().commands[0]?.output, ["beforeafter"]);
  } finally {
    session.dispose();
  }
});

test("managed shell session treats spoofed sentinels as command output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-spoof-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf '__PI_CMD_DONE__:cmd-1:0:/tmp\\nreal-output\\n'");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.ok(lastCommand?.output.includes("__PI_CMD_DONE__:cmd-1:0:/tmp"));
    assert.ok(lastCommand?.output.includes("real-output"));
  } finally {
    session.dispose();
  }
});

test("managed bash session does not expose a reusable helper nonce for completion spoofing", { skip: !existsSync("/bin/bash") ? "/bin/bash is unavailable" : false }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-nonce-spoof-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/bash", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand([
      "nonce=$(declare -f __pi_eval | grep -Eo '[0-9a-f]{32}' | head -n1 || true)",
      "if [ -n \"$nonce\" ]; then /usr/bin/printf '\\033\\\\__PI_CMD_DONE__:%s:cmd-1:0:/tmp\\n' \"$nonce\"; fi",
      "sleep 0.1",
      "echo after-spoof",
    ].join("\n"));
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.match((lastCommand?.output ?? []).join("\n"), /after-spoof/);
    assert.notEqual(session.state.cwd, "/tmp");
  } finally {
    session.dispose();
  }
});

test("managed bash session keeps xtrace from leaking sentinel nonce", { skip: !existsSync("/bin/bash") ? "/bin/bash is unavailable" : false }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-xtrace-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/bash", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("PS4='LEAK[$(IFS= read -r a; IFS= read -r b; IFS= read -r c; printf %s%s%s \"$a\" \"$b\" \"$c\")] '; set -x; echo user-output; return 0");
    await waitForCommand();
    await session.runCommand("echo after-xtrace");
    await waitForCommand();

    const output = store.getSnapshot().commands.flatMap((command) => command.output).join("\n");
    assert.match(output, /user-output/);
    assert.match(output, /after-xtrace/);
    assert.doesNotMatch(output, /__PI_CMD_(?:START|DONE)__.*[0-9a-f]{32}/);
  } finally {
    session.dispose();
  }
});

test("managed shell session completes when command closes or redirects primary control fd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-close-fd-"));
  const redirectedFdPath = join(cwd, "fd4.txt");
  const redirectedStderrPath = join(cwd, "stderr.txt");
  const redirectedStdoutPath = join(cwd, "stdout.txt");
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("exec 4>&-\necho after-close-fd");
    await waitForCommand();

    const closedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(closedCommand?.exitCode, 0);
    assert.match((closedCommand?.output ?? []).join("\n"), /after-close-fd/);

    await session.runCommand("exec 4>&- 5>&-\necho after-close-low-backup-fd");
    await waitForCommand();

    const lowBackupClosedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lowBackupClosedCommand?.exitCode, 0);
    assert.match((lowBackupClosedCommand?.output ?? []).join("\n"), /after-close-low-backup-fd/);

    await session.runCommand("exec 4>&- 9>&-\necho after-close-backup-fd");
    await waitForCommand();

    const backupClosedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(backupClosedCommand?.exitCode, 0);
    assert.match((backupClosedCommand?.output ?? []).join("\n"), /after-close-backup-fd/);

    await session.runCommand(`exec 4> ${quoteForTestShell(redirectedFdPath)}\necho after-redirect-fd`);
    await waitForCommand();

    const redirectedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(redirectedCommand?.exitCode, 0);
    assert.match((redirectedCommand?.output ?? []).join("\n"), /after-redirect-fd/);
    assert.doesNotMatch(readFileSync(redirectedFdPath, "utf8"), /__PI_CMD_DONE__/);

    await session.runCommand(`exec 4>&- 9>&- 2> ${quoteForTestShell(redirectedStderrPath)}\necho after-redirect-stderr`);
    await waitForCommand();

    const stderrRedirectedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(stderrRedirectedCommand?.exitCode, 0);
    assert.match((stderrRedirectedCommand?.output ?? []).join("\n"), /after-redirect-stderr/);
    assert.doesNotMatch(readFileSync(redirectedStderrPath, "utf8"), /__PI_CMD_DONE__/);

    await session.runCommand(`exec 4>&- 9>&-\nexec > ${quoteForTestShell(redirectedStdoutPath)} 2>&1\necho after-redirect-stdio`);
    await waitForCommand();

    const stdioRedirectedCommand = store.getSnapshot().commands.at(-1);
    assert.equal(stdioRedirectedCommand?.exitCode, 0);
    const redirectedStdout = readFileSync(redirectedStdoutPath, "utf8");
    assert.equal(redirectedStdout, "after-redirect-stdio\n");
    assert.doesNotMatch(redirectedStdout, /__PI_CMD_DONE__/);
  } finally {
    session.dispose();
  }
});

test("managed shell session completes when command redirects stdout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stdout-redirect-"));
  const redirectedPath = join(cwd, "redirected.txt");
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand(`exec > ${quoteForTestShell(redirectedPath)}\necho hidden-output`);
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.equal(readFileSync(redirectedPath, "utf8"), "hidden-output\n");
  } finally {
    session.dispose();
  }
});

test("managed shell session prevents sourced commands from consuming wrapper stdin", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stdin-guard-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("IFS= read -r stolen || true\necho after-stdin-read");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    const output = (lastCommand?.output ?? []).join("\n");
    assert.match(output, /after-stdin-read/);
    assert.doesNotMatch(output, /__PI_CMD_DONE__/);
  } finally {
    session.dispose();
  }
});

test("managed shell session completes when command output leaves an OSC sequence unterminated", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-unterminated-osc-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf '\\033]52;c;secret'");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    const output = (lastCommand?.output ?? []).join("\n");
    assert.doesNotMatch(output, /secret/);
    assert.doesNotMatch(output, /\]52/);
  } finally {
    session.dispose();
  }
});

test("managed shell session survives user functions that shadow printf and source", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-shadow-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf(){ :; }; source(){ :; }");
    await waitForCommand();
    assert.equal(store.getSnapshot().commands.at(-1)?.exitCode, 0);

    await session.runCommand("echo after-shadow");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.match((lastCommand?.output ?? []).join("\n"), /after-shadow/);
  } finally {
    session.dispose();
  }
});

test("managed bash session survives user function named command", { skip: !existsSync("/bin/bash") ? "/bin/bash is unavailable" : false }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-shadow-command-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/bash", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("command(){ :; }; printf(){ :; }; source(){ :; }");
    await waitForCommand();
    assert.equal(store.getSnapshot().commands.at(-1)?.exitCode, 0);

    await session.runCommand("echo after-command-shadow");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.match((lastCommand?.output ?? []).join("\n"), /after-command-shadow/);
  } finally {
    session.dispose();
  }
});

test("managed bash session survives user function named builtin", { skip: !existsSync("/bin/bash") ? "/bin/bash is unavailable" : false }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-shadow-builtin-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/bash", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("builtin(){ :; }");
    await waitForCommand();
    assert.equal(store.getSnapshot().commands.at(-1)?.exitCode, 0);

    await session.runCommand("echo after-builtin-shadow");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.match((lastCommand?.output ?? []).join("\n"), /after-builtin-shadow/);
  } finally {
    session.dispose();
  }
});

test("managed sh session survives user function named command", { skip: !existsSync("/bin/sh") ? "/bin/sh is unavailable" : false }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-sh-shadow-command-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession("/bin/sh", cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("command(){ :; }; printf(){ :; }");
    await waitForCommand();
    assert.equal(store.getSnapshot().commands.at(-1)?.exitCode, 0);

    await session.runCommand("echo after-sh-command-shadow");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.match((lastCommand?.output ?? []).join("\n"), /after-sh-command-shadow/);
  } finally {
    session.dispose();
  }
});

test("managed shell session removes private temp command scripts on dispose", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-cleanup-"));
  const originalUmask = process.umask(0);
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});
  const tempDir = Reflect.get(session, "tempDir") as string;

  try {
    await session.ensureReady();
    await session.runCommand("sleep 5 # powerline-secret-marker");
    const commandFilePath = Reflect.get(session, "currentCommandFilePath") as string | null;
    assert.ok(commandFilePath);
    if (process.platform !== "win32") {
      assert.equal(statSync(commandFilePath).mode & 0o777, 0o600);
    }
    assert.equal(existsSync(tempDir), true);
    session.dispose();
    assert.equal(existsSync(tempDir), false);
  } finally {
    process.umask(originalUmask);
    session.dispose();
  }
});

test("managed shell session cleanup ignores command-mutated script path variables", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-cleanup-var-"));
  const victimPath = join(cwd, "victim.txt");
  writeFileSync(victimPath, "keep\n");
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});
  const tempDir = Reflect.get(session, "tempDir") as string;

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand(`__pi_source_file=${quoteForTestShell(victimPath)}`);
    await waitForCommand();

    assert.equal(readFileSync(victimPath, "utf8"), "keep\n");
    assert.equal(existsSync(join(tempDir, "cmd-1.sh")), false);
  } finally {
    session.dispose();
  }
});

test("managed shell session completes after partial stderr output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-stderr-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("printf err >&2; printf 'ok\\n'");
    await waitForCommand();

    const lastCommand = store.getSnapshot().commands.at(-1);
    assert.equal(lastCommand?.exitCode, 0);
    assert.ok(lastCommand?.output.includes("ok"));
  } finally {
    session.dispose();
  }
});

test("managed shell session recovers cleanly after interrupt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-shell-interrupt-"));
  const store = new BashTranscriptStore({ transcriptMaxLines: 100, transcriptMaxBytes: 64 * 1024 });
  const session = new ManagedShellSession(managedShellPath, cwd, store, () => {}, () => {});

  const waitForCommand = async () => {
    const start = Date.now();
    while (session.state.running && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.state.running, false);
  };

  try {
    await session.ensureReady();
    await session.runCommand("sleep 5");
    await new Promise((resolve) => setTimeout(resolve, 100));
    session.interrupt();
    await waitForCommand();

    const interruptedCommand = store.getSnapshot().commands[0];
    assert.equal(interruptedCommand?.exitCode, 130);

    await session.runCommand("printf 'after\\n'");
    await waitForCommand();

    const snapshot = store.getSnapshot();
    const lastCommand = snapshot.commands[snapshot.commands.length - 1];
    assert.equal(lastCommand?.command, "printf 'after\\n'");
    assert.equal(lastCommand?.exitCode, 0);
    assert.ok(lastCommand?.output.includes("after"));
  } finally {
    session.dispose();
  }
});

test("bash editor Tab accepts the current ghost suggestion without opening autocomplete", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let accepted = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      optionsRef: {
        isBashModeActive: () => true,
        isShellRunning: () => false,
        onExitBashMode() {},
        onInterrupt() {},
        onNotify() {},
        onSubmitCommand() {},
      },
      keybindingsRef: {
        matches(_data: string, id: string) {
          return id === "tui.input.tab";
        },
      },
      isShowingAutocomplete() {
        return false;
      },
      acceptGhostSuggestion() {
        accepted = true;
        return true;
      },
    }, "tab");

    assert.equal(accepted, true);
  } finally {
    links.cleanup();
  }
});

test("bash editor render sanitizes ghost suggestion text", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { CustomEditor } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js", import.meta.url).href);
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const superRender = CustomEditor.prototype.render;
    CustomEditor.prototype.render = function render() {
      return ["top", `${this.getText()}\x1b[7m \x1b[0m`, "bottom"];
    };

    try {
      const editor = new BashModeEditor(
        { requestRender() {}, terminal: { columns: 80, rows: 24 } },
        {},
        keybindings,
        {
          keybindings,
          isBashModeActive: () => true,
          isShellRunning: () => false,
          onExitBashMode() {},
          onSubmitCommand() {},
          onInterrupt() {},
          onNotify() {},
          getHistoryEntries: () => [],
          resolveGhostSuggestion: async () => null,
        },
      );

      editor.handleInput("g");
      Reflect.set(editor, "ghost", { value: "git\x1b]52;c;secret\x07 status\x1b[2J", source: "project-history" });

      const rendered = editor.render(80).join("\n");
      assert.match(rendered, /it status/);
      assert.doesNotMatch(rendered, /secret/);
      assert.doesNotMatch(rendered, /\x1b\]52/);
      assert.doesNotMatch(rendered, /\x1b\[2J/);
    } finally {
      CustomEditor.prototype.render = superRender;
    }
  } finally {
    links.cleanup();
  }
});

test("bash editor strips terminal controls from direct input before storing text", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.handleInput("raw\x1b]52;c;secret\x07chunk\x1b[2J");

    assert.equal(editor.getText(), "rawchunk");
  } finally {
    links.cleanup();
  }
});

test("bash editor strips terminal controls from split bracketed paste", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.handleInput("\x1b[20");
    editor.handleInput("0~safe\x1b]52;c;sec");
    editor.handleInput("ret\x07text\x1b[201");
    editor.handleInput("~");
    editor.handleInput("\x1b[200~more\x1b[31mtext\x1b[201~");
    editor.handleInput("\x1b[200~tail");
    editor.handleInput("\x1b");
    editor.handleInput("[201~");

    assert.equal(editor.getText(), "safetextmoretexttail");
    assert.equal(Reflect.get(editor, "isInPaste"), false);
  } finally {
    links.cleanup();
  }
});

test("bash editor strips bracketed paste OSC when ST is split across chunks", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.handleInput("\x1b[200~safe\x1b]52;c;secret\x1b");
    editor.handleInput("\\text\x1b[201~");

    assert.equal(editor.getText(), "safetext");
    assert.equal(Reflect.get(editor, "isInPaste"), false);
    assert.equal(Reflect.get(editor, "pasteControlState"), "normal");
  } finally {
    links.cleanup();
  }
});

test("bash editor recall helper strips terminal controls", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let recalled = "";
    getMethod(BashModeEditor.prototype, "setTextFromRecall").call({
      setText(value: string) {
        recalled = value;
      },
    }, "keep\x1b]52;c;secret\x07\x1b[2J text");

    assert.equal(recalled, "keep text");
  } finally {
    links.cleanup();
  }
});

test("bash editor does not submit pasted multiline input while bracketed paste is active", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { CustomEditor } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js", import.meta.url).href);

    let delegated = 0;
    let submitted = 0;
    const superHandleInput = CustomEditor.prototype.handleInput;
    CustomEditor.prototype.handleInput = function handleInput() {
      delegated += 1;
    };

    try {
      getMethod(BashModeEditor.prototype, "handleInput").call({
        isInPaste: true,
        optionsRef: {
          isBashModeActive: () => true,
          isShellRunning: () => false,
          onExitBashMode() {},
          onInterrupt() {},
          onNotify() {},
          onSubmitCommand() {
            submitted += 1;
          },
          getHistoryEntries() {
            return [];
          },
          resolveGhostSuggestion: async () => null,
        },
        keybindingsRef: {
          matches(data: string, id: string) {
            return data === "\r" && id === "tui.input.submit";
          },
        },
      }, "\r");
    } finally {
      CustomEditor.prototype.handleInput = superHandleInput;
    }

    assert.equal(submitted, 0);
    assert.equal(delegated, 1);
  } finally {
    links.cleanup();
  }
});

test("bash editor refreshes shell ghost state after a bracketed paste completes", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { CustomEditor } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js", import.meta.url).href);

    let delegated = 0;
    let scheduled = 0;
    const superHandleInput = CustomEditor.prototype.handleInput;
    CustomEditor.prototype.handleInput = function handleInput() {
      delegated += 1;
      Reflect.set(this, "isInPaste", false);
    };

    try {
      getMethod(BashModeEditor.prototype, "handleInput").call({
        isInPaste: true,
        optionsRef: {
          isBashModeActive: () => true,
          isShellRunning: () => false,
          onExitBashMode() {},
          onInterrupt() {},
          onNotify() {},
          onSubmitCommand() {},
          getHistoryEntries() {
            return [];
          },
          resolveGhostSuggestion: async () => null,
        },
        keybindingsRef: {
          matches() {
            return false;
          },
        },
        getExpandedText() {
          return "git status";
        },
        isShellCompletionContext() {
          return true;
        },
        shellHistoryIndex: 3,
        shellHistoryItems: ["git status"],
        shellHistoryDraft: "git",
        scheduleGhostUpdate() {
          scheduled += 1;
        },
      }, "\r");
    } finally {
      CustomEditor.prototype.handleInput = superHandleInput;
    }

    assert.equal(delegated, 1);
    assert.equal(scheduled, 1);
  } finally {
    links.cleanup();
  }
});

test("bash editor inserts Finder file drops as path strings", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    let scheduled = 0;
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.handleInput("\x1b[200~file:///Users/nico/Desktop/Screen%20Shot%202026-05-08.png\x1b[201~");
    assert.equal(editor.getText(), "/Users/nico/Desktop/Screen Shot 2026-05-08.png");

    editor.handleInput(" ");
    editor.handleInput("\x1b[200~/Users/nico/Documents/Project\\ Folder\x1b[201~");
    assert.equal(editor.getText(), "/Users/nico/Desktop/Screen Shot 2026-05-08.png /Users/nico/Documents/Project\\ Folder");

    const shellEditor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => true,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );
    Reflect.set(shellEditor, "scheduleGhostUpdate", () => {
      scheduled += 1;
    });

    shellEditor.handleInput("\x1b[200~file:///Users/nico/Pictures/Finder%20Image.png\nfile:///Users/nico/Desktop/Capture.png\x1b[201~");
    assert.equal(shellEditor.getText(), "/Users/nico/Pictures/Finder\\ Image.png /Users/nico/Desktop/Capture.png");
    assert.equal(scheduled, 1);
  } finally {
    links.cleanup();
  }
});

test("one-off bash autocomplete provider stays inactive even inside bang commands", async () => {
  const provider = new OneOffBashAutocompleteProvider();
  const suggestions = await provider.getSuggestions(
    ["!!gi"],
    0,
    4,
    { signal: new AbortController().signal },
  );

  assert.equal(suggestions, null);
});

test("bash autocomplete providers return null synchronously in shell contexts", () => {
  const signal = new AbortController().signal;

  const bashSuggestions = new BashAutocompleteProvider().getSuggestions(["git st"], 0, 6, { signal });
  const oneOffSuggestions = new OneOffBashAutocompleteProvider().getSuggestions(["!git st"], 0, 7, { signal });

  assert.equal(bashSuggestions, null);
  assert.equal(oneOffSuggestions, null);
  assert.equal(bashSuggestions instanceof Promise, false);
  assert.equal(oneOffSuggestions instanceof Promise, false);
});

test("mode-aware autocomplete provider preserves synchronous default results", () => {
  const signal = new AbortController().signal;
  const syncResult = {
    items: [{ value: "status", label: "status" }],
    prefix: "st",
  };
  const provider = new ModeAwareAutocompleteProvider(
    {
      getSuggestions() {
        return syncResult;
      },
      applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
        return { lines, cursorLine, cursorCol };
      },
    },
    new BashAutocompleteProvider(),
    new OneOffBashAutocompleteProvider(),
    () => false,
  );

  const suggestions = provider.getSuggestions(["st"], 0, 2, { signal });

  assert.equal(suggestions, syncResult);
  assert.equal(suggestions instanceof Promise, false);
});

test("one-off bash autocomplete provider stays inactive before the bang command starts", async () => {
  const provider = new OneOffBashAutocompleteProvider();

  assert.equal(provider.shouldTriggerFileCompletion(["!git status"], 0, 0), false);
  assert.equal(
    await provider.getSuggestions(["!git status"], 0, 0, { signal: new AbortController().signal }),
    null,
  );
});

test("bash editor refreshGhostSuggestion reuses the ghost scheduling path", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let scheduled = false;

    getMethod(BashModeEditor.prototype, "refreshGhostSuggestion").call({
      scheduleGhostUpdate() {
        scheduled = true;
      },
    });

    assert.equal(scheduled, true);
  } finally {
    links.cleanup();
  }
});

test("bash editor dismiss clears autocomplete when mode turns off", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let aborted = false;
    let cancelled = false;
    let rendered = false;
    const fakeAbort = { abort() { aborted = true; } };
    const fakeEditor = {
      historyIndex: 7,
      shellHistoryIndex: 2,
      shellHistoryItems: ["git status"],
      shellHistoryDraft: "git st",
      ghostAbort: fakeAbort,
      ghost: { value: "git status", source: "project-history" },
      clearGhostSuggestion() {
        this.ghostAbort?.abort();
        this.ghostAbort = null;
        this.ghost = null;
      },
      cancelAutocomplete() {
        cancelled = true;
      },
      tui: {
        requestRender() {
          rendered = true;
        },
      },
    };

    getMethod(BashModeEditor.prototype, "dismissBashModeUi").call(fakeEditor);

    assert.equal(aborted, true);
    assert.equal(cancelled, true);
    assert.equal(rendered, true);
    assert.equal(fakeEditor.historyIndex, 7);
    assert.equal(fakeEditor.shellHistoryIndex, -1);
  } finally {
    links.cleanup();
  }
});

test("bash editor shell history state does not clobber the base prompt history index", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const fakeEditor = {
      historyIndex: 5,
      shellHistoryIndex: -1,
      shellHistoryItems: [],
      shellHistoryDraft: "",
      ghostAbort: null,
      ghost: null,
      optionsRef: {
        getHistoryEntries: () => ["git stash", "git status"],
        onNotify: () => {},
      },
      getExpandedText() {
        return "git st";
      },
      setText() {},
      clearGhostSuggestion() {},
      scheduleGhostUpdate() {},
    };

    getMethod(BashModeEditor.prototype, "navigateShellHistory").call(fakeEditor, -1);

    assert.equal(fakeEditor.historyIndex, 5);
    assert.equal(fakeEditor.shellHistoryIndex, 0);
  } finally {
    links.cleanup();
  }
});

test("bash editor shell history recall strips terminal controls", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let recalled = "";
    const fakeEditor = {
      shellHistoryIndex: -1,
      shellHistoryItems: [],
      shellHistoryDraft: "",
      optionsRef: {
        getHistoryEntries: () => ["echo \x1b]52;c;secret\x07safe\x1b[2J"],
        onNotify: () => {},
      },
      getExpandedText() {
        return "echo";
      },
      setText(value: string) {
        recalled = value;
      },
      clearGhostSuggestion() {},
      scheduleGhostUpdate() {},
    };

    getMethod(BashModeEditor.prototype, "navigateShellHistory").call(fakeEditor, -1);

    assert.equal(recalled, "echo safe");
    assert.doesNotMatch(recalled, /secret/);
    assert.doesNotMatch(recalled, /\x1b/);
  } finally {
    links.cleanup();
  }
});

test("bash editor prompt history recall strips terminal controls", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.addToHistory("prompt\x1b]52;c;secret\x07safe\x1b[2J");
    editor.setText("");
    editor.handleInput("\x1b[A");

    assert.equal(editor.getText(), "promptsafe");
  } finally {
    links.cleanup();
  }
});

test("bash editor recalls prompt history from the editor end without losing the live draft", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const createEditor = () => new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    const editor = createEditor();
    editor.addToHistory("older prompt");
    editor.addToHistory("previous prompt");
    editor.setText("draft");

    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "previous prompt");

    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "older prompt");

    editor.handleInput("\x1b[B");
    assert.equal(editor.getText(), "previous prompt");

    editor.handleInput("\x1b[B");
    assert.equal(editor.getText(), "draft");

    const midLineEditor = createEditor();
    midLineEditor.addToHistory("previous prompt");
    midLineEditor.setText("draft");
    midLineEditor.handleInput("\x1b[D");
    midLineEditor.handleInput("\x1b[A");

    assert.equal(midLineEditor.getText(), "draft");
  } finally {
    links.cleanup();
  }
});

test("bash editor escape exits bash mode", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let exited = false;
    let interrupted = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      optionsRef: {
        isBashModeActive: () => true,
        onExitBashMode: () => {
          exited = true;
        },
        isShellRunning: () => false,
        onInterrupt: () => {
          interrupted = true;
        },
      },
      keybindingsRef: {
        matches(data: string, id: string) {
          return data === "escape" && id === "app.interrupt";
        },
      },
    }, "escape");

    assert.equal(exited, true);
    assert.equal(interrupted, false);
  } finally {
    links.cleanup();
  }
});

test("bash editor right arrow accepts an empty-prompt ghost suggestion without submitting", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let accepted = false;
    let submitted = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      optionsRef: {
        isBashModeActive: () => true,
        isShellRunning: () => false,
        onExitBashMode: () => {},
        onSubmitCommand: () => {
          submitted = true;
        },
        onInterrupt: () => {},
        onNotify: () => {},
      },
      keybindingsRef: {
        matches(data: string, id: string) {
          return data === "right" && id === "tui.editor.cursorRight";
        },
      },
      isShowingAutocomplete() {
        return false;
      },
      acceptGhostSuggestion() {
        accepted = true;
        return true;
      },
    }, "right");

    assert.equal(accepted, true);
    assert.equal(submitted, false);
  } finally {
    links.cleanup();
  }
});

test("bash editor right arrow accepts ghost text for one-off bang commands", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let accepted = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      optionsRef: {
        isBashModeActive: () => false,
      },
      keybindingsRef: {
        matches(data: string, id: string) {
          return data === "right" && id === "tui.editor.cursorRight";
        },
      },
      getExpandedText() {
        return "!git st";
      },
      isOneOffBashCommandContext() {
        return true;
      },
      acceptGhostSuggestion() {
        accepted = true;
        return true;
      },
    }, "right");

    assert.equal(accepted, true);
  } finally {
    links.cleanup();
  }
});

test("bash editor runs copied Pi app action handlers for alt-enter", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const { setKittyProtocolActive } = await import(new URL("../node_modules/@earendil-works/pi-tui/dist/keys.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const editor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    let handled = 0;
    editor.actionHandlers.set("app.message.followUp", () => {
      handled += 1;
    });

    try {
      setKittyProtocolActive(false);
      editor.handleInput("\x1b\r");
      assert.equal(handled, 1);

      setKittyProtocolActive(true);
      editor.handleInput("\x1b[13;3u");
      assert.equal(handled, 2);
    } finally {
      setKittyProtocolActive(false);
    }
  } finally {
    links.cleanup();
  }
});

test("bash editor command-z undoes deleted text for supported encodings only", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const createEditor = (options: {
      keybindings?: typeof keybindings;
      isBashModeActive?: () => boolean;
      isShellRunning?: () => boolean;
      onExitBashMode?: () => void;
      onInterrupt?: () => void;
      resolveGhostSuggestion?: (text: string) => Promise<null>;
    } = {}) => new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      options.keybindings ?? keybindings,
      {
        keybindings: options.keybindings ?? keybindings,
        isBashModeActive: options.isBashModeActive ?? (() => false),
        isShellRunning: options.isShellRunning ?? (() => false),
        onExitBashMode: options.onExitBashMode ?? (() => {}),
        onSubmitCommand() {},
        onInterrupt: options.onInterrupt ?? (() => {}),
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: options.resolveGhostSuggestion ?? (async () => null),
      },
    );

    for (const data of ["\x1b[122;9u", "\x1b[122;9:1u", "\x1b[122;9:2u", "\x1b[27;9;122~"]) {
      const editor = createEditor();

      for (const char of "hello") editor.handleInput(char);
      editor.handleInput("\x7f");
      assert.equal(editor.getText(), "hell");

      editor.handleInput(data);
      assert.equal(editor.getText(), "hello");
    }

    const editor = createEditor();

    for (const char of "hello") editor.handleInput(char);
    editor.handleInput("\x7f");
    editor.handleInput("\x1b[122;9u");
    assert.equal(editor.getText(), "hello");

    editor.handleInput("\x1b[122;9:3u");
    assert.equal(editor.getText(), "hello");

    editor.handleInput("\x7f");
    editor.handleInput("\x1b[27;9;90~");
    assert.equal(editor.getText(), "hell");

    const plainEditor = createEditor();
    plainEditor.handleInput("z");
    assert.equal(plainEditor.getText(), "z");

    for (const action of ["app.interrupt", "app.clear"]) {
      let exited = false;
      let interrupted = false;
      const customizedKeybindings = new KeybindingsManager({ [action]: "super+z" });
      assert.equal(customizedKeybindings.matches("\x1b[122;9u", action), true);
      const customizedEditor = createEditor({
        keybindings: customizedKeybindings,
        isBashModeActive: () => true,
        isShellRunning: () => true,
        onExitBashMode: () => {
          exited = true;
        },
        onInterrupt: () => {
          interrupted = true;
        },
      });

      for (const char of "hello") customizedEditor.handleInput(char);
      customizedEditor.handleInput("\x7f");
      customizedEditor.handleInput("\x1b[122;9u");

      assert.equal(customizedEditor.getText(), "hello");
      assert.equal(exited, false);
      assert.equal(interrupted, false);
    }
  } finally {
    links.cleanup();
  }
});

test("bash editor command-z resets shell history and updates ghost state", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    const createEditor = (options: {
      isBashModeActive?: () => boolean;
      resolveGhostSuggestion?: (text: string) => Promise<null>;
    } = {}) => new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: options.isBashModeActive ?? (() => false),
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: options.resolveGhostSuggestion ?? (async () => null),
      },
    );
    const ghostRefreshes: string[] = [];
    const shellEditor = createEditor({
      isBashModeActive: () => true,
      resolveGhostSuggestion: async (text) => {
        ghostRefreshes.push(text);
        return null;
      },
    });

    shellEditor.handleInput("a");
    shellEditor.handleInput("\x7f");
    Reflect.set(shellEditor, "shellHistoryIndex", 0);
    Reflect.set(shellEditor, "shellHistoryItems", ["git status"]);
    Reflect.set(shellEditor, "shellHistoryDraft", "git");
    shellEditor.handleInput("\x1b[122;9u");

    assert.equal(shellEditor.getText(), "a");
    assert.equal(Reflect.get(shellEditor, "shellHistoryIndex"), -1);
    assert.deepEqual(Reflect.get(shellEditor, "shellHistoryItems"), []);
    assert.equal(Reflect.get(shellEditor, "shellHistoryDraft"), "");
    assert.equal(ghostRefreshes.at(-1), "a");

    const plainEditor = createEditor();
    plainEditor.handleInput("z");
    plainEditor.handleInput("\x7f");
    Reflect.set(plainEditor, "ghost", { value: "stale" });
    plainEditor.handleInput("\x1b[122;9u");
    assert.equal(Reflect.get(plainEditor, "ghost"), null);
  } finally {
    links.cleanup();
  }
});

test("bash editor command arrows jump to editor boundaries", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { KeybindingsManager } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url).href);
    const keybindings = KeybindingsManager.create();
    let renderRequests = 0;
    const editor = new BashModeEditor(
      { requestRender() { renderRequests += 1; }, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );

    editor.setText("alpha\nbravo\ncharlie");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    editor.handleInput("\x1b[A");
    assert.notDeepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput("\x1b[B");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    editor.handleInput("\x1b[1;9A");
    assert.notDeepEqual(editor.getCursor(), { line: 0, col: 0 });

    editor.handleInput("\x1b[1;10A");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    editor.handleInput("\x1b[27;10;66~");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    editor.handleInput("\x1b[27;10;65~");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    editor.handleInput("\x1b[57420;10u");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    editor.handleInput("\x1b[57423;10u");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    editor.handleInput("\x1b[1;10F");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    editor.handleInput("\x1b[1;10:3A");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 7 });

    const customEditor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        editorBoundaryShortcuts: { start: "ctrl+shift+u", end: "ctrl+shift+d" },
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );
    customEditor.setText("alpha\nbravo\ncharlie");
    customEditor.handleInput("\x1b[117;6u");
    assert.deepEqual(customEditor.getCursor(), { line: 0, col: 0 });
    customEditor.handleInput("\x1b[100;6u");
    assert.deepEqual(customEditor.getCursor(), { line: 2, col: 7 });

    const configuredCommandEditor = new BashModeEditor(
      { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      {},
      keybindings,
      {
        keybindings,
        isBashModeActive: () => false,
        isShellRunning: () => false,
        onExitBashMode() {},
        onSubmitCommand() {},
        editorBoundaryShortcuts: { start: "super+shift+up", end: "super+shift+down" },
        onInterrupt() {},
        onNotify() {},
        getHistoryEntries: () => [],
        resolveGhostSuggestion: async () => null,
      },
    );
    configuredCommandEditor.setText("alpha\nbravo\ncharlie");
    configuredCommandEditor.handleInput("\x1b[1;10A");
    assert.deepEqual(configuredCommandEditor.getCursor(), { line: 0, col: 0 });
    configuredCommandEditor.handleInput("\x1b[1;10B");
    assert.deepEqual(configuredCommandEditor.getCursor(), { line: 2, col: 7 });

    assert.equal(renderRequests, 6);
  } finally {
    links.cleanup();
  }
});

test("bash editor enter does not accept ghost text while a shell command is running", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let warned = false;
    let submitted = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      ghost: { value: "git status", source: "project-history" },
      optionsRef: {
        isBashModeActive: () => true,
        isShellRunning: () => true,
        onExitBashMode: () => {},
        onInterrupt: () => {},
        onSubmitCommand: () => {
          submitted = true;
        },
        onNotify: (message: string) => {
          warned = message === "Shell command already running";
        },
      },
      keybindingsRef: {
        matches(_data: string, id: string) {
          return id === "tui.input.submit";
        },
      },
      getExpandedText() {
        return "git st";
      },
      isShowingAutocomplete() {
        return false;
      },
      acceptGhostSuggestion() {
        throw new Error("ghost should not be accepted while running");
      },
    }, "enter");

    assert.equal(warned, true);
    assert.equal(submitted, false);
  } finally {
    links.cleanup();
  }
});

test("bash editor enter submits the typed command without accepting ghost text", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let submittedCommand = "";

    getMethod(BashModeEditor.prototype, "handleInput").call({
      ghost: { value: "git diff --staged", source: "project-history" },
      optionsRef: {
        isBashModeActive: () => true,
        isShellRunning: () => false,
        onExitBashMode: () => {},
        onInterrupt: () => {},
        onNotify: () => {},
        onSubmitCommand: (command: string) => {
          submittedCommand = command;
        },
      },
      keybindingsRef: {
        matches(_data: string, id: string) {
          return id === "tui.input.submit";
        },
      },
      getExpandedText() {
        return "git diff";
      },
      acceptGhostSuggestion() {
        throw new Error("enter should not accept ghost text");
      },
      clearGhostSuggestion() {},
      setText() {},
      refreshGhostSuggestion() {},
      shellHistoryIndex: -1,
      shellHistoryItems: [],
      shellHistoryDraft: "",
    }, "enter");

    assert.equal(submittedCommand, "git diff");
  } finally {
    links.cleanup();
  }
});

test("one-off bang submit does not accept ghost text before submitting", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const { CustomEditor } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js", import.meta.url).href);

    let delegated = 0;
    const superHandleInput = CustomEditor.prototype.handleInput;
    CustomEditor.prototype.handleInput = function handleInput() {
      delegated += 1;
    };

    try {
      getMethod(BashModeEditor.prototype, "handleInput").call({
        ghost: { value: "!git diff --staged", source: "project-history" },
        optionsRef: {
          isBashModeActive: () => false,
        },
        keybindingsRef: {
          matches(_data: string, id: string) {
            return id === "tui.input.submit";
          },
        },
        getExpandedText() {
          return "!git diff";
        },
        isOneOffBashCommandContext() {
          return true;
        },
        isShellCompletionContext() {
          return true;
        },
        acceptGhostSuggestion() {
          throw new Error("enter should not accept ghost text for one-off bash commands");
        },
      }, "enter");
    } finally {
      CustomEditor.prototype.handleInput = superHandleInput;
    }

    assert.equal(delegated, 1);
  } finally {
    links.cleanup();
  }
});

test("bash editor does not accept a hidden ghost suggestion when the cursor is not at the end", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    const accepted = getMethod(BashModeEditor.prototype, "acceptGhostSuggestion").call({
      ghost: { value: "git status", source: "project-history" },
      getExpandedText() {
        return "git st";
      },
      getCursor() {
        return { line: 0, col: 3 };
      },
      setText() {
        throw new Error("hidden ghost should not be accepted");
      },
      clearGhostSuggestion() {},
    });

    assert.equal(accepted, false);
  } finally {
    links.cleanup();
  }
});

test("bash editor submit clears the prompt and refreshes the empty ghost suggestion", async () => {
  const links = ensureEditorModuleLinks();

  try {
    const { BashModeEditor } = await import("../bash-mode/editor.ts");
    let submitted = false;
    let cleared = false;
    let refreshed = false;

    getMethod(BashModeEditor.prototype, "handleInput").call({
      optionsRef: {
        isBashModeActive: () => true,
        isShellRunning: () => false,
        onExitBashMode: () => {},
        onInterrupt: () => {},
        onNotify: () => {},
        onSubmitCommand: (command: string) => {
          submitted = command === "git status";
        },
      },
      keybindingsRef: {
        matches(_data: string, id: string) {
          return id === "tui.input.submit";
        },
      },
      isShowingAutocomplete() {
        return false;
      },
      acceptGhostSuggestion() {
        return false;
      },
      getExpandedText() {
        return "git status";
      },
      clearGhostSuggestion() {},
      setText(value: string) {
        cleared = value === "";
      },
      refreshGhostSuggestion() {
        refreshed = true;
      },
      shellHistoryIndex: 3,
      shellHistoryItems: ["git status"],
      shellHistoryDraft: "git st",
    }, "enter");

    assert.equal(submitted, true);
    assert.equal(cleared, true);
    assert.equal(refreshed, true);
  } finally {
    links.cleanup();
  }
});

test("project history is persisted atomically with no leftover temp files", () => {
  const originalHome = process.env.HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "powerline-history-atomic-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "powerline-history-atomic-cwd-"));
  const historyDir = join(homeDir, ".pi", "agent", "powerline-footer", "bash-history");
  process.env.HOME = homeDir;

  try {
    appendProjectHistory(cwd, "git status", cwd);
    appendProjectHistory(cwd, "git stash", cwd);

    assert.deepEqual(
      readProjectHistory(cwd).map((entry) => entry.command),
      ["git stash", "git status"],
    );

    // The atomic temp-file + rename write must not leave .tmp files behind.
    const leftoverTempFiles = readdirSync(historyDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftoverTempFiles, [], "no temp files should remain after an atomic history write");
  } finally {
    process.env.HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

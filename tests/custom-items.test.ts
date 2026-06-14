import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses, normalizeExtensionStatusValue, parsePowerlineConfig, mergeSegmentOptions, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, normalizeCompactExtensionStatus, stripTerminalControlSequences } from "../powerline-config.ts";
import { renderSegment } from "../segments.ts";

test("parsePowerlineConfig supports object config with custom items", () => {
  const config = parsePowerlineConfig(
    {
      preset: "compact",
      customItems: [
        { id: "ci", statusKey: "ci-status", position: "right", prefix: "CI" },
        { id: "review", position: "secondary", hideWhenMissing: false },
      ],
    },
    ["default", "compact"],
  );

  assert.equal(config.preset, "compact");
  assert.equal(config.customItems.length, 2);
  assert.equal(config.customItems[0].id, "ci");
  assert.equal(config.customItems[0].statusKey, "ci-status");
  assert.equal(config.customItems[1].statusKey, "review");
  assert.equal(config.customItems[1].hideWhenMissing, false);
  assert.equal(config.mouseScroll, true);
  assert.equal(config.fixedEditor, true);
});

test("parsePowerlineConfig supports disabling mouse scroll", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", mouseScroll: false },
    ["default", "compact"],
  );

  assert.equal(config.preset, "compact");
  assert.equal(config.mouseScroll, false);
});

test("parsePowerlineConfig supports disabling fixed editor", () => {
  const config = parsePowerlineConfig(
    { preset: "compact", fixedEditor: false },
    ["default", "compact"],
  );

  assert.equal(config.preset, "compact");
  assert.equal(config.fixedEditor, false);
});

test("parsePowerlineConfig extracts supported segment options", () => {
  const config = parsePowerlineConfig(
    {
      preset: "default",
      model: { showThinkingLevel: true },
      path: { mode: "full", maxLength: 120 },
      git: { showBranch: false, showStaged: false, showUnstaged: true, showUntracked: false, polling: "branch" },
      time: { format: "12h", showSeconds: true },
    },
    ["default", "compact"],
  );

  assert.deepEqual(config.segmentOptions, {
    model: { showThinkingLevel: true },
    path: { mode: "full", maxLength: 120 },
    git: { showBranch: false, showStaged: false, showUnstaged: true, showUntracked: false, polling: "branch" },
    time: { format: "12h", showSeconds: true },
  });
});

test("mergeSegmentOptions lets user config override preset segment defaults", () => {
  assert.deepEqual(
    mergeSegmentOptions(
      { path: { mode: "basename", maxLength: 20 }, git: { showBranch: true, showUntracked: true } },
      { path: { mode: "full" }, git: { showUntracked: false } },
    ),
    {
      model: {},
      path: { mode: "full", maxLength: 20 },
      git: { showBranch: true, showUntracked: false },
      time: {},
    },
  );
});

test("mergeSegmentsWithCustomItems appends custom segment ids by position", () => {
  const merged = mergeSegmentsWithCustomItems(
    {
      leftSegments: ["path"],
      rightSegments: ["git"],
      secondarySegments: ["extension_statuses"],
      separator: "powerline",
    },
    [
      { id: "ci", statusKey: "ci", position: "left", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "timer", statusKey: "timer", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
      { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    ],
  );

  assert.deepEqual(merged.leftSegments, ["path", "custom:ci"]);
  assert.deepEqual(merged.rightSegments, ["git", "custom:timer"]);
  assert.deepEqual(merged.secondarySegments, ["extension_statuses", "custom:review"]);
});

test("nextPowerlineSettingWithPreset preserves object settings", () => {
  const updated = nextPowerlineSettingWithPreset({ preset: "default", customItems: [{ id: "ci" }] }, "compact");
  if (typeof updated !== "object" || updated === null || Array.isArray(updated)) {
    assert.fail("expected an object powerline setting");
  }
  if (!("preset" in updated)) {
    assert.fail("expected preset to be preserved on the updated powerline setting");
  }
  if (!("customItems" in updated)) {
    assert.fail("expected customItems to be preserved on the updated powerline setting");
  }

  assert.equal(updated.preset, "compact");
  assert.deepEqual(updated.customItems, [{ id: "ci" }]);
});

test("nextPowerlineSettingWithOptions preserves object settings", () => {
  const updated = nextPowerlineSettingWithOptions(
    { preset: "default", customItems: [{ id: "ci" }], mouseScroll: false },
    { fixedEditor: false },
    "compact",
  );
  if (typeof updated !== "object" || updated === null || Array.isArray(updated)) {
    assert.fail("expected an object powerline setting");
  }

  assert.equal(updated.preset, "default");
  assert.equal(updated.fixedEditor, false);
  assert.equal(updated.mouseScroll, false);
  assert.deepEqual(updated.customItems, [{ id: "ci" }]);
});

test("nextPowerlineSettingWithOptions converts string presets to object settings", () => {
  assert.deepEqual(nextPowerlineSettingWithOptions("compact", { mouseScroll: true }, "compact"), {
    preset: "compact",
    mouseScroll: true,
  });
});

test("collectHiddenExtensionStatusKeys includes default custom status keys", () => {
  const hidden = collectHiddenExtensionStatusKeys([
    { id: "ci", statusKey: "ci-status", position: "right", hideWhenMissing: true, excludeFromExtensionStatuses: true },
    { id: "review", statusKey: "review", position: "secondary", hideWhenMissing: true, excludeFromExtensionStatuses: false },
  ]);

  assert.equal(hidden.has("ci-status"), true);
  assert.equal(hidden.has("review"), false);
});

test("normalizeCompactExtensionStatus strips baked-in trailing separators", () => {
  assert.equal(normalizeCompactExtensionStatus("CI ok · "), "CI ok");
  assert.equal(normalizeCompactExtensionStatus("CI ok |   "), "CI ok");
  assert.equal(normalizeCompactExtensionStatus("[notice] queued"), null);
});

test("extension status normalization strips terminal control sequences", () => {
  assert.equal(normalizeExtensionStatusValue("\x1b[31mCI ok\x1b[0m · "), "CI ok");
  assert.equal(normalizeExtensionStatusValue("safe\x1b]52;c;secret\x07 text"), "safe text");
  assert.equal(normalizeCompactExtensionStatus("\x1b[33m[notice] queued\x1b[0m"), null);
});

test("normalizeExtensionStatusValue keeps notification-style statuses renderable for custom items", () => {
  assert.equal(normalizeExtensionStatusValue("[review] queued · "), "[review] queued");
});

test("path segment abbreviated mode clamps maxLength one to a single ellipsis", () => {
  const rendered = renderSegment("path", {
    cwd: "/very/long/path/here",
    shellModeActive: false,
    options: { path: { mode: "abbreviated", maxLength: 1 } },
    theme: {} as never,
    colors: {} as never,
    model: null,
    thinkingLevel: "off",
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    customItemsById: new Map(),
  });

  assert.equal(rendered.visible, true);
  assert.equal(rendered.content.includes("/very/long/path/here"), false);
  assert.equal(rendered.content.includes("…"), true);
});

function renderPathName(cwd: string): string {
  const rendered = renderSegment("path", {
    cwd,
    shellModeActive: false,
    options: { path: { mode: "basename" } },
    theme: {} as never,
    colors: {} as never,
    model: null,
    thinkingLevel: "off",
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    customItemsById: new Map(),
  });

  assert.equal(rendered.visible, true);
  return stripTerminalControlSequences(rendered.content).replace(/^\S+\s+/, "");
}

test("path segment basename includes repository folder for bare linked worktree roots", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "powerline-worktree-parent-"));
  const repoDir = join(parentDir, "powerline-footer");
  const worktreeDir = join(repoDir, "main");
  const gitDir = join(repoDir, ".bare", "worktrees", "main");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);

  assert.equal(renderPathName(worktreeDir), "powerline-footer/main");

  writeFileSync(join(worktreeDir, ".git"), "not a gitdir file\n");
  assert.equal(renderPathName(worktreeDir), "powerline-footer/main");
});

test("path segment basename includes repository folder for standard linked worktree roots", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "powerline-worktree-parent-"));
  const repoDir = join(parentDir, "powerline-footer");
  const worktreeDir = join(parentDir, "main");
  const gitDir = join(repoDir, ".git", "worktrees", "main");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);

  assert.equal(renderPathName(worktreeDir), "powerline-footer/main");
});

test("path segment only abbreviates cwd inside the home directory", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/Users/al";

  try {
    const rendered = renderSegment("path", {
      cwd: "/Users/alice/project",
      shellModeActive: false,
      options: { path: { mode: "full" } },
      theme: {} as never,
      colors: {} as never,
      model: null,
      thinkingLevel: "off",
      git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
      extensionStatuses: new Map(),
      customItemsById: new Map(),
    });

    assert.equal(rendered.visible, true);
    assert.equal(rendered.content.includes("~/ice/project"), false);
    assert.equal(rendered.content.includes("/Users/alice/project"), true);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("path segment uses os home when home environment is unset", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;

  try {
    const osHome = homedir();
    const rendered = renderSegment("path", {
      cwd: osHome,
      shellModeActive: false,
      options: { path: { mode: "full" } },
      theme: {} as never,
      colors: {} as never,
      model: null,
      thinkingLevel: "off",
      git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
      extensionStatuses: new Map(),
      customItemsById: new Map(),
    });

    assert.equal(rendered.visible, true);
    assert.equal(rendered.content.includes("~"), true);
    assert.equal(rendered.content.includes(osHome), false);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  }
});

test("getNotificationExtensionStatuses skips promoted hidden status keys", () => {
  const statuses = new Map<string, string>([
    ["ci-status", "[ci] queued"],
    ["review", "\x1b[33m[review] running\x1b[0m"],
    ["plain", "plain status"],
  ]);
  const hidden = new Set(["ci-status"]);

  assert.deepEqual(getNotificationExtensionStatuses(statuses, hidden), ["[review] running"]);
});

test("custom item prefixes and values render without external terminal controls", () => {
  const config = parsePowerlineConfig(
    { customItems: [{ id: "ci", prefix: "\x1b]52;c;secret\x07CI" }] },
    ["default"],
  );
  const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
  const rendered = renderSegment("custom:ci", {
    cwd: "/repo",
    shellModeActive: false,
    options: {},
    theme: {} as never,
    colors: {} as never,
    model: null,
    thinkingLevel: "off",
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map([["ci", "\x1b[31mpass\x1b[0m\x1b]0;title\x07"]]),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById,
  });

  assert.equal(rendered.visible, true);
  assert.equal(rendered.content, "CI · pass");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLoadedCounts, getRecentSessions } from "../welcome.ts";

function withIsolatedProject<T>(fn: (root: string, home: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "powerline-welcome-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(project);

  try {
    return fn(root, home);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("welcome discovery ignores symlinked context, extension, skill, and template entries", () => {
  withIsolatedProject((root, home) => {
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    const targetContext = join(root, "outside-AGENTS.md");
    writeFileSync(targetContext, "secret context\n");
    symlinkSync(targetContext, join(agentDir, "AGENTS.md"));

    const targetExtension = join(root, "outside-extension");
    mkdirSync(targetExtension, { recursive: true });
    writeFileSync(join(targetExtension, "index.ts"), "export default {};\n");

    const targetSkill = join(root, "outside-skill");
    mkdirSync(targetSkill, { recursive: true });
    writeFileSync(join(targetSkill, "SKILL.md"), "# skill\n");

    const targetTemplates = join(root, "outside-templates");
    mkdirSync(targetTemplates, { recursive: true });
    writeFileSync(join(targetTemplates, "leaked.md"), "prompt\n");

    const extensionsDir = join(home, ".pi", "agent", "extensions");
    const skillsDir = join(home, ".pi", "agent", "skills");
    const commandsDir = join(home, ".pi", "agent", "commands");
    mkdirSync(extensionsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(commandsDir, { recursive: true });
    symlinkSync(targetExtension, join(extensionsDir, "linked-extension"), "dir");
    symlinkSync(targetSkill, join(skillsDir, "linked-skill"), "dir");
    symlinkSync(targetTemplates, join(commandsDir, "linked-templates"), "dir");
    symlinkSync(join(targetTemplates, "leaked.md"), join(commandsDir, "linked-template.md"));

    assert.deepEqual(discoverLoadedCounts(), {
      contextFiles: 0,
      extensions: 0,
      skills: 0,
      promptTemplates: 0,
    });
  });
});

test("welcome discovery ignores symlinked settings files", () => {
  withIsolatedProject((root) => {
    const project = process.cwd();
    const targetSettings = join(root, "outside-settings.json");
    writeFileSync(targetSettings, JSON.stringify({ packages: ["npm:linked-extension"] }) + "\n");

    mkdirSync(join(project, ".pi"), { recursive: true });
    symlinkSync(targetSettings, join(project, ".pi", "settings.json"));

    assert.deepEqual(discoverLoadedCounts(), {
      contextFiles: 0,
      extensions: 0,
      skills: 0,
      promptTemplates: 0,
    });
  });
});

test("recent sessions ignore symlinked session directories", () => {
  withIsolatedProject((root, home) => {
    const targetSessionDir = join(root, "outside-sessions", "--secret-project--");
    mkdirSync(targetSessionDir, { recursive: true });
    writeFileSync(join(targetSessionDir, "session.jsonl"), "{}\n");

    const sessionsDir = join(home, ".pi", "agent", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    symlinkSync(targetSessionDir, join(sessionsDir, "linked-session"), "dir");
    symlinkSync(join(targetSessionDir, "session.jsonl"), join(sessionsDir, "linked-session.jsonl"));

    assert.deepEqual(getRecentSessions(), []);
  });
});

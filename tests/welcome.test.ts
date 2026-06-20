import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "../welcome.ts";

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

test("welcome rendering strips terminal controls from dynamic text", () => {
  const unsafe = "safe\x1b]52;c;secret\x07\x1b[2Jtext\nnext";
  const session = { name: unsafe, timeAgo: "just\x1b[31m now" };

  for (const component of [
    new WelcomeComponent(unsafe, unsafe, [session]),
    new WelcomeHeader(unsafe, unsafe, [session]),
  ]) {
    const rendered = component.render(100).join("\n");
    assert.ok(!rendered.includes("\x1b]52"), "OSC controls must be stripped");
    assert.ok(!rendered.includes("\x1b[2J"), "CSI controls from data must be stripped");
    assert.ok(!rendered.includes("secret"), "OSC payload must be stripped");
    assert.ok(rendered.includes("safetext next"), "sanitized display text remains visible");
  }
});

test("welcome discovery ignores symlinked root scan directories", () => {
  withIsolatedProject((root, home) => {
    const outsideExtensions = join(root, "outside-extensions");
    const outsideSkills = join(root, "outside-skills");
    const outsideCommands = join(root, "outside-commands");
    const outsideSessions = join(root, "outside-sessions");
    mkdirSync(outsideExtensions, { recursive: true });
    mkdirSync(outsideSkills, { recursive: true });
    mkdirSync(outsideCommands, { recursive: true });
    mkdirSync(join(outsideSessions, "--secret-project--"), { recursive: true });
    writeFileSync(join(outsideExtensions, "leaked.js"), "export default {};\n");
    mkdirSync(join(outsideSkills, "leaked"), { recursive: true });
    writeFileSync(join(outsideSkills, "leaked", "SKILL.md"), "# leaked\n");
    writeFileSync(join(outsideCommands, "leaked.md"), "prompt\n");
    writeFileSync(join(outsideSessions, "--secret-project--", "session.jsonl"), "{}\n");

    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(outsideExtensions, join(agentDir, "extensions"), "dir");
    symlinkSync(outsideSkills, join(agentDir, "skills"), "dir");
    symlinkSync(outsideCommands, join(agentDir, "commands"), "dir");
    symlinkSync(outsideSessions, join(agentDir, "sessions"), "dir");

    assert.deepEqual(discoverLoadedCounts(), {
      contextFiles: 0,
      extensions: 0,
      skills: 0,
      promptTemplates: 0,
    });
    assert.deepEqual(getRecentSessions(), []);
  });
});

test("welcome discovery bounds extension and skill directory scans", () => {
  withIsolatedProject((_root, home) => {
    const extensionsDir = join(home, ".pi", "agent", "extensions");
    const skillsDir = join(home, ".pi", "agent", "skills");
    mkdirSync(extensionsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    for (let i = 0; i < 2005; i++) {
      writeFileSync(join(extensionsDir, `ext-${i}.js`), "export default {};\n");
      const skillDir = join(skillsDir, `skill-${i}`);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    }

    const counts = discoverLoadedCounts();
    assert.equal(counts.extensions, 2000);
    assert.equal(counts.skills, 2000);
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

test("welcome discovery bounds deeply nested prompt templates", () => {
  withIsolatedProject((_root, home) => {
    const commandsDir = join(home, ".pi", "agent", "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "visible.md"), "prompt\n");

    let deepDir = commandsDir;
    for (let i = 0; i < 12; i++) {
      deepDir = join(deepDir, `d${i}`);
      mkdirSync(deepDir, { recursive: true });
    }
    writeFileSync(join(deepDir, "too-deep.md"), "prompt\n");

    assert.equal(discoverLoadedCounts().promptTemplates, 1);
  });
});

test("recent sessions bound deeply nested session scans", () => {
  withIsolatedProject((_root, home) => {
    let deepDir = join(home, ".pi", "agent", "sessions");
    mkdirSync(deepDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      deepDir = join(deepDir, `d${i}`);
      mkdirSync(deepDir, { recursive: true });
    }
    writeFileSync(join(deepDir, "session.jsonl"), "{}\n");

    assert.deepEqual(getRecentSessions(), []);
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

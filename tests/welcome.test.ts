import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "../welcome.ts";

function restoreEnv(name: "HOME" | "PI_CODING_AGENT_DIR", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function withIsolatedProject<T>(fn: (root: string, home: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "powerline-welcome-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  process.chdir(project);

  try {
    return fn(root, home);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("HOME", previousHome);
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}

function withTemporaryHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "powerline-welcome-home-"));
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    run(home);
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
    rmSync(home, { recursive: true, force: true });
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
    assert.doesNotMatch(rendered, /secret/);
    assert.doesNotMatch(rendered, /\x1b\]52/);
    assert.doesNotMatch(rendered, /\x1b\[2J/);
  }
});

test("welcome discovery bounds extension scans", () => {
  withIsolatedProject((_root, home) => {
    const extensionsDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    for (let i = 0; i < 2050; i++) {
      const dir = join(extensionsDir, `ext-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
    }

    assert.equal(discoverLoadedCounts().extensions, 2000);
  });
});

test("welcome discovery bounds deeply nested skills", () => {
  withIsolatedProject((_root, home) => {
    const skillsDir = join(home, ".pi", "agent", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const rootSkill = join(skillsDir, "root-skill");
    mkdirSync(rootSkill, { recursive: true });
    writeFileSync(join(rootSkill, "SKILL.md"), "# skill\n");

    let deepDir = skillsDir;
    for (let i = 0; i < 12; i++) {
      deepDir = join(deepDir, `d${i}`);
      mkdirSync(deepDir, { recursive: true });
    }
    writeFileSync(join(deepDir, "SKILL.md"), "# too deep\n");

    assert.equal(discoverLoadedCounts().skills, 1);
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

test("discoverLoadedCounts ignores dangling skill symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "powerline-welcome-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const skillsDir = join(home, ".pi", "agent", "skills");
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();
  const originalDebug = console.debug;
  const debugCalls: unknown[][] = [];

  mkdirSync(join(skillsDir, "valid-skill"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(skillsDir, "valid-skill", "SKILL.md"), "# Valid skill\n");
  symlinkSync(join(root, "missing-skill"), join(skillsDir, "pi-intercom"), "dir");

  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };

  try {
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    process.chdir(project);

    assert.equal(discoverLoadedCounts().skills, 1);
    assert.deepEqual(debugCalls, []);
  } finally {
    console.debug = originalDebug;
    process.chdir(originalCwd);
    restoreEnv("HOME", originalHome);
    restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("getRecentSessions prefers cwd basename from session header", () => {
  withTemporaryHome((home) => {
    const sessionsDir = join(home, ".pi", "agent", "sessions", "--Users-nico-dev-encoded-name--");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "session.jsonl"), JSON.stringify({ cwd: "/Users/nico/dev/my-dashed-project" }) + "\n");

    assert.equal(getRecentSessions(1)[0]?.name, "my-dashed-project");
  });
});

test("getRecentSessions falls back to encoded directory when header cwd is unusable", () => {
  withTemporaryHome((home) => {
    const root = join(home, ".pi", "agent", "sessions");
    const cases = [
      ["invalid-json", "not-json\n"],
      ["missing-cwd", JSON.stringify({ type: "session" }) + "\n"],
      ["non-string-cwd", JSON.stringify({ cwd: 123 }) + "\n"],
    ];

    for (const [name, content] of cases) {
      const sessionsDir = join(root, `--Users-nico-dev-${name}--`);
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "session.jsonl"), content);
    }

    const names = getRecentSessions(10).map((session) => session.name);
    assert.ok(names.includes("json"));
    assert.ok(names.includes("cwd"));
  });
});

test("welcome discovery respects PI_CODING_AGENT_DIR for agent-global files", () => {
  withTemporaryHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "powerline-welcome-agent-dir-"));
    const project = join(root, "project");
    const agentDir = join(root, "agent-dir");
    const originalCwd = process.cwd();

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      mkdirSync(project, { recursive: true });
      mkdirSync(join(agentDir, "extensions", "local-ext"), { recursive: true });
      mkdirSync(join(agentDir, "skills", "skill-a"), { recursive: true });
      mkdirSync(join(agentDir, "commands"), { recursive: true });
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(agentDir, "AGENTS.md"), "# Agent instructions\n");
      writeFileSync(join(agentDir, "extensions", "local-ext", "index.ts"), "export default {};\n");
      writeFileSync(join(agentDir, "skills", "skill-a", "SKILL.md"), "# Skill\n");
      writeFileSync(join(agentDir, "commands", "hello.md"), "hello\n");
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pkg-one@1.0.0"] }));
      writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "# Should not count\n");
      process.chdir(project);

      assert.deepEqual(discoverLoadedCounts(), {
        contextFiles: 1,
        extensions: 2,
        skills: 1,
        promptTemplates: 1,
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("getRecentSessions reads custom agent sessions and existing legacy sessions", () => {
  withTemporaryHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "powerline-welcome-sessions-"));
    const agentDir = join(root, "agent-dir");

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const customSessionDir = join(agentDir, "sessions", "--custom--");
      const legacySessionDir = join(home, ".pi", "sessions", "--legacy--");
      mkdirSync(customSessionDir, { recursive: true });
      mkdirSync(legacySessionDir, { recursive: true });
      writeFileSync(join(customSessionDir, "session.jsonl"), JSON.stringify({ cwd: "/tmp/custom-project" }) + "\n");
      writeFileSync(join(legacySessionDir, "session.jsonl"), JSON.stringify({ cwd: "/tmp/legacy-project" }) + "\n");

      const names = getRecentSessions(10).map((session) => session.name);
      assert.ok(names.includes("custom-project"));
      assert.ok(names.includes("legacy-project"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAUX_PROVIDER_PATH = new URL("../node_modules/@earendil-works/pi-ai/dist/providers/faux.js", import.meta.url).href;

function ensurePiModuleLinks(): { cleanup: () => void } {
  const nodeModulesDir = join(process.cwd(), "node_modules", "@earendil-works");
  mkdirSync(nodeModulesDir, { recursive: true });
  const links = [
    {
      link: join(nodeModulesDir, "pi-coding-agent"),
      target: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
    },
    {
      link: join(nodeModulesDir, "pi-ai"),
      target: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
    },
  ];

  const createdLinks: string[] = [];
  for (const { link, target } of links) {
    if (!existsSync(link)) {
      symlinkSync(target, link);
      createdLinks.push(link);
    }
  }

  return {
    cleanup() {
      for (const link of createdLinks.reverse()) {
        if (existsSync(link)) {
          rmSync(link, { recursive: true, force: true });
        }
      }
    },
  };
}

test("parseVibeGenerateArgs preserves multi-word themes with optional counts", async () => {
  const { parseVibeGenerateArgs } = await import("../working-vibes.ts");

  assert.deepEqual(parseVibeGenerateArgs(["star", "trek", "200"]), { theme: "star trek", count: 200 });
  assert.deepEqual(parseVibeGenerateArgs(["star", "trek"]), { theme: "star trek", count: 100 });
  assert.deepEqual(parseVibeGenerateArgs(["mafia", "9999"]), { theme: "mafia", count: 500 });
  assert.equal(parseVibeGenerateArgs([]), null);
});

test("generateVibesBatch includes a system prompt so faux providers can return text", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await import(FAUX_PROVIDER_PATH);
    const { generateVibesBatch, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);

      registration.setResponses([
        (context) => {
          assert.match(context.systemPrompt ?? "", /loading messages/i);
          return fauxAssistantMessage("Engaging warp drive...\nRunning diagnostics...");
        },
      ]);

      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "test-provider" && modelId === "test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });

      assert.equal(setVibeModel("test-provider/test-model"), true);

      const result = await generateVibesBatch("star trek", 2);

      assert.equal(result.success, true);
      assert.equal(result.count, 2);
      assert.equal(existsSync(result.filePath), true);
      assert.deepEqual(readFileSync(result.filePath, "utf8").trim().split("\n"), [
        "Engaging warp drive...",
        "Running diagnostics...",
      ]);
    } finally {
      registration.unregister();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    links.cleanup();
  }
});

test("generateVibesBatch caps model output to the requested count", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await import(FAUX_PROVIDER_PATH);
    const { generateVibesBatch, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);

      registration.setResponses([
        fauxAssistantMessage("First signal...\nSecond signal...\nThird signal..."),
      ]);

      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "test-provider" && modelId === "test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });

      assert.equal(setVibeModel("test-provider/test-model"), true);

      const result = await generateVibesBatch("star trek", 2);

      assert.equal(result.success, true);
      assert.equal(result.count, 2);
      assert.deepEqual(readFileSync(result.filePath, "utf8").trim().split("\n"), [
        "First signal...",
        "Second signal...",
      ]);
    } finally {
      registration.unregister();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    links.cleanup();
  }
});

test("on-demand vibe generation includes a system prompt for providers that require instructions", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await import(FAUX_PROVIDER_PATH);
    const { initVibeManager, onVibeAgentStart, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);

      registration.setResponses([
        (context) => {
          assert.match(context.systemPrompt ?? "", /loading messages/i);
          return fauxAssistantMessage("Engaging warp drive...");
        },
      ]);

      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "test-provider" && modelId === "test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });

      assert.equal(setVibeTheme("star trek"), true);
      assert.equal(setVibeModel("test-provider/test-model"), true);

      const updates: Array<string | undefined> = [];
      onVibeAgentStart();
      onVibeBeforeAgentStart("fix a bug", (message) => {
        updates.push(message);
      });

      const start = Date.now();
      while (!updates.includes("Engaging warp drive...") && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(updates[0], "Channeling star trek...");
      assert.ok(updates.includes("Engaging warp drive..."));
    } finally {
      registration.unregister();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    links.cleanup();
  }
});

test("generateVibesBatch preserves provider errors instead of reporting an empty response", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await import(FAUX_PROVIDER_PATH);
    const { generateVibesBatch, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);

      registration.setResponses([
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Instructions are required",
        }),
      ]);

      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "test-provider" && modelId === "test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });

      assert.equal(setVibeModel("test-provider/test-model"), true);

      const result = await generateVibesBatch("noir", 2);

      assert.equal(result.success, false);
      assert.equal(result.error, "Instructions are required");
    } finally {
      registration.unregister();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    links.cleanup();
  }
});

test("working vibe settings refuse symlinked global settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const targetPath = join(home, "target-settings.json");
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n");
    symlinkSync(targetPath, settingsPath);

    const { setVibeTheme } = await import("../working-vibes.ts");

    assert.equal(setVibeTheme("noir"), false);
    assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), { theme: "dark" });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("working vibe settings refuse dangling symlinked global settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    symlinkSync(join(home, "missing-settings.json"), settingsPath);

    const { setVibeTheme } = await import("../working-vibes.ts");

    assert.equal(setVibeTheme("noir"), false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("working vibe settings refuse symlinked global settings parent", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const targetDir = mkdtempSync(join(tmpdir(), "powerline-vibes-target-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    symlinkSync(targetDir, join(home, ".pi"));

    const { setVibeTheme } = await import("../working-vibes.ts");

    assert.equal(setVibeTheme("noir"), false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("working vibe file reads ignore symlinked paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const targetPath = join(home, "target-vibes.txt");
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi", "agent", "vibes"), { recursive: true });
    writeFileSync(targetPath, "Leaked vibe...\n");
    symlinkSync(targetPath, join(home, ".pi", "agent", "vibes", "noir.txt"));

    const { getVibeFileCount, hasVibeFile } = await import("../working-vibes.ts");

    assert.equal(hasVibeFile("noir"), false);
    assert.equal(getVibeFileCount("noir"), 0);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("setVibeTheme persists atomically, preserving unrelated keys and leaving no temp files", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  const agentDir = join(home, ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  process.env.HOME = home;

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", keep: 1 }, null, 2) + "\n");

    const { setVibeTheme } = await import("../working-vibes.ts");

    assert.equal(setVibeTheme("noir"), true);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(parsed.workingVibe, "noir");
    assert.equal(parsed.keep, 1, "unrelated settings keys must be preserved");
    assert.equal(parsed.theme, "dark", "unrelated settings keys must be preserved");

    // The atomic write must clean up its temp file on success.
    const leftoverTempFiles = readdirSync(agentDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftoverTempFiles, [], "no temp files should remain after an atomic write");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("generateVibesBatch creates the vibes directory on first write", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await import(FAUX_PROVIDER_PATH);
    const { generateVibesBatch, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);

      registration.setResponses([
        fauxAssistantMessage("First signal...\nSecond signal...")
      ]);

      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "test-provider" && modelId === "test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });

      assert.equal(setVibeModel("test-provider/test-model"), true);

      const result = await generateVibesBatch("star trek", 2);

      assert.equal(result.success, true);
      assert.equal(result.count, 2);
      assert.equal(readFileSync(result.filePath, "utf8").trim().split("\n").length, 2);
    } finally {
      registration.unregister();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    links.cleanup();
  }
});

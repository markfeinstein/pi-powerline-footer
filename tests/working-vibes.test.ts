import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const FAUX_PROVIDER_PATH = new URL("../node_modules/@earendil-works/pi-ai/dist/providers/faux.js", import.meta.url).href;

async function importFauxProviderTools() {
  try {
    return await import("@earendil-works/pi-ai/compat");
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    return import(FAUX_PROVIDER_PATH);
  }
}

function ensurePiModuleLinks(): { cleanup: () => void } {
  const nodeModulesDir = join(process.cwd(), "node_modules", "@earendil-works");
  const requiredModules = ["pi-coding-agent", "pi-ai"];
  const missing = requiredModules.filter((name) => !existsSync(join(nodeModulesDir, name)));
  assert.deepEqual(
    missing,
    [],
    `Missing test dependencies: ${missing.join(", ")}. Run npm ci before running working-vibes tests.`,
  );

  return { cleanup() {} };
}

test("parseVibeGenerateArgs preserves multi-word themes with optional counts", async () => {
  const { parseVibeGenerateArgs } = await import("../working-vibes.ts");

  assert.deepEqual(parseVibeGenerateArgs(["star", "trek", "200"]), { theme: "star trek", count: 200 });
  assert.deepEqual(parseVibeGenerateArgs(["star", "trek"]), { theme: "star trek", count: 100 });
  assert.deepEqual(parseVibeGenerateArgs(["mafia", "9999"]), { theme: "mafia", count: 500 });
  assert.deepEqual(parseVibeGenerateArgs(["2049"]), { theme: "2049", count: 100 });
  assert.deepEqual(parseVibeGenerateArgs(["lofi", "3abc"]), { theme: "lofi 3abc", count: 100 });
  assert.equal(parseVibeGenerateArgs([]), null);
});

test("oversized vibe files are ignored", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { getVibeFileCount } = await import("../working-vibes.ts");
    const vibesDir = join(home, ".pi", "agent", "vibes");
    mkdirSync(vibesDir, { recursive: true });
    writeFileSync(join(vibesDir, "huge.txt"), `${"Loading...\n".repeat(14000)}`);

    assert.equal(getVibeFileCount("huge"), 0);
  } finally {
    process.env.HOME = previousHome;
  }
});

test("file-mode vibes strip terminal controls before display", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { initVibeManager, onVibeBeforeAgentStart, setVibeMode, setVibeTheme } = await import("../working-vibes.ts");
    const vibesDir = join(home, ".pi", "agent", "vibes");
    mkdirSync(vibesDir, { recursive: true });
    writeFileSync(join(vibesDir, "noir.txt"), "\x1b]52;c;secret\x07Shadow\x1b[31m walking...\n");

    initVibeManager({ modelRegistry: {} } as never);
    assert.equal(setVibeTheme("noir"), true);
    assert.equal(setVibeMode("file"), true);

    const updates: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => updates.push(message));

    assert.deepEqual(updates, ["Channeling noir...", "Shadow walking..."]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("working vibe applies generated text when generation resolves before agent_start", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { initVibeManager, onVibeAgentStart, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");
    initVibeManager({ modelRegistry: {} } as never);
    assert.equal(setVibeTheme("noir"), true);
    assert.equal(setVibeModel("invalid-model-spec"), true);

    const updates: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => updates.push(message));
    await new Promise((resolve) => setTimeout(resolve, 0));
    onVibeAgentStart((message) => updates.push(message));

    assert.deepEqual(updates, ["Channeling noir...", "Working..."]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("working vibe clears pre-start placeholder on agent end", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { initVibeManager, onVibeAgentEnd, onVibeAgentStart, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");
    initVibeManager({ modelRegistry: {} } as never);
    assert.equal(setVibeTheme("noir"), true);
    assert.equal(setVibeModel("invalid-model-spec"), true);

    const updates: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => updates.push(message));
    await new Promise((resolve) => setTimeout(resolve, 0));
    onVibeAgentStart();
    onVibeAgentEnd((message) => updates.push(message));

    assert.deepEqual(updates, ["Channeling noir...", undefined]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("working vibe retries a repeated message after callback failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { initVibeManager, onVibeAgentEnd, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");
    initVibeManager({ modelRegistry: {} } as never);
    assert.equal(setVibeTheme("noir"), true);
    assert.equal(setVibeModel("invalid-model-spec"), true);

    const updates: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => updates.push(message));
    assert.deepEqual(updates, ["Channeling noir..."]);

    assert.throws(() => onVibeAgentEnd(() => {
      throw new Error("ui unavailable");
    }), /ui unavailable/);
    onVibeAgentEnd((message) => updates.push(message));

    assert.deepEqual(updates, ["Channeling noir...", undefined]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("file-mode vibes restart their shuffle for each session", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  const originalDateNow = Date.now;
  process.env.HOME = home;
  Date.now = () => 12345;

  try {
    const { initVibeManager, onVibeBeforeAgentStart, setVibeMode, setVibeTheme } = await import("../working-vibes.ts");
    const vibesDir = join(home, ".pi", "agent", "vibes");
    mkdirSync(vibesDir, { recursive: true });
    writeFileSync(join(vibesDir, "noir.txt"), "First...\nSecond...\nThird...\n");

    initVibeManager({ modelRegistry: {} } as never);
    assert.equal(setVibeTheme("noir"), true);
    assert.equal(setVibeMode("file"), true);
    const firstSession: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => firstSession.push(message));

    initVibeManager({ modelRegistry: {} } as never);
    const secondSession: Array<string | undefined> = [];
    onVibeBeforeAgentStart("investigate", (message) => secondSession.push(message));

    assert.equal(firstSession[0], "Channeling noir...");
    assert.equal(secondSession[0], "Channeling noir...");
    assert.equal(secondSession[1], firstSession[1]);
  } finally {
    Date.now = originalDateNow;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("vibe model setting strips terminal controls before storage and display", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { getVibeModel, initVibeManager, setVibeModel } = await import("../working-vibes.ts");
    initVibeManager({ modelRegistry: {} } as never);

    assert.equal(setVibeModel("test-provider/test-model\x1b]52;c;secret\x07\x1b[31m"), true);
    assert.equal(getVibeModel(), "test-provider/test-model");

    const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf-8"));
    assert.equal(settings.workingVibeModel, "test-provider/test-model");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("generateVibesBatch includes a system prompt so faux providers can return text", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
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
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
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

test("on-demand vibe generation strips terminal controls before display", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
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
          return fauxAssistantMessage("\x1b]52;c;secret\x07Engaging \x1b[31mwarp drive...");
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
      assert.equal(updates.some((message) => message?.includes("\x1b")), false);
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

test("on-demand vibe truncation does not split surrogate pairs", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ workingVibeMaxLength: 8 }) + "\n");

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
    const { initVibeManager, onVibeAgentStart, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);
      registration.setResponses([() => fauxAssistantMessage("🚀🚀🚀🚀🚀🚀")]);

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

      assert.equal(setVibeTheme("space"), true);
      assert.equal(setVibeModel("test-provider/test-model"), true);

      const updates: Array<string | undefined> = [];
      onVibeAgentStart();
      onVibeBeforeAgentStart("launch", (message) => updates.push(message));

      const start = Date.now();
      while (!updates.some((message) => message !== "Channeling space..." && message?.endsWith("...")) && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const generated = updates.find((message) => message !== "Channeling space...");
      assert.equal(generated, "🚀🚀🚀🚀🚀...");
      assert.doesNotMatch(generated ?? "", /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
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

test("on-demand vibe generation redacts prompt secrets before model calls", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
    const { initVibeManager, onVibeAgentStart, onVibeBeforeAgentStart, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);
      let observedPrompt = "";

      registration.setResponses([
        (context) => {
          const message = context.messages[0]?.content[0];
          observedPrompt = message?.type === "text" ? message.text : "";
          return fauxAssistantMessage("Safe diagnostics...");
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

      assert.equal(setVibeTheme("noir"), true);
      assert.equal(setVibeModel("test-provider/test-model"), true);

      const updates: Array<string | undefined> = [];
      onVibeAgentStart();
      onVibeBeforeAgentStart("deploy TOKEN=super-secret Authorization: Basic dXNlcjpwYXNz, next Authorization: Token abc123", (message) => updates.push(message));

      const start = Date.now();
      while (!updates.includes("Safe diagnostics...") && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(updates.includes("Safe diagnostics..."));
      assert.doesNotMatch(observedPrompt, /super-secret|dXNlcjpwYXNz|abc123/);
      assert.match(observedPrompt, /TOKEN=\[redacted\]/);
      assert.match(observedPrompt, /Authorization: \[redacted\]/i);
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

test("tool-call vibe generation redacts authorization values", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ workingVibeRefreshInterval: 0 }) + "\n");

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
    const { initVibeManager, onVibeAgentStart, onVibeToolCall, setVibeModel, setVibeTheme } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);
      let observedPrompt = "";
      registration.setResponses([
        (context) => {
          const message = context.messages[0]?.content[0];
          observedPrompt = message?.type === "text" ? message.text : "";
          return fauxAssistantMessage("Tool safe...");
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
      assert.equal(setVibeTheme("noir"), true);
      assert.equal(setVibeModel("test-provider/test-model"), true);

      const updates: Array<string | undefined> = [];
      onVibeAgentStart();
      onVibeToolCall("bash", { command: "curl -H 'authorization=token abc123' https://example.test" }, (message) => updates.push(message));

      const start = Date.now();
      while (!updates.includes("Tool safe...") && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(updates.includes("Tool safe..."));
      assert.doesNotMatch(observedPrompt, /abc123/);
      assert.match(observedPrompt, /authorization=\[redacted\]/i);
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

test("hasVibeFile requires at least one usable vibe", async () => {
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { hasVibeFile } = await import("../working-vibes.ts");
    const vibesDir = join(home, ".pi", "agent", "vibes");
    mkdirSync(vibesDir, { recursive: true });
    writeFileSync(join(vibesDir, "noir.txt"), "missing ellipsis\n\n");

    assert.equal(hasVibeFile("noir"), false);

    writeFileSync(join(vibesDir, "noir.txt"), "Shadow walking...\n");
    assert.equal(hasVibeFile("noir"), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-ascii vibe themes generate distinct file paths", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
    const { generateVibesBatch, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    const registration = registerFauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });

    try {
      const model = registration.getModel("test-model");
      assert.ok(model);
      registration.setResponses([
        fauxAssistantMessage("First signal..."),
        fauxAssistantMessage("Second signal..."),
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

      const tokyo = await generateVibesBatch("東京", 1);
      const rocket = await generateVibesBatch("🚀", 1);

      assert.equal(tokyo.success, true);
      assert.equal(rocket.success, true);
      assert.notEqual(tokyo.filePath, rocket.filePath);
      assert.notEqual(basename(tokyo.filePath), "theme.txt");
      assert.notEqual(basename(rocket.filePath), "theme.txt");
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
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
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

test("working vibe files refuse symlinked vibe directories", async () => {
  const links = ensurePiModuleLinks();
  const home = mkdtempSync(join(tmpdir(), "powerline-vibes-home-"));
  const targetDir = mkdtempSync(join(tmpdir(), "powerline-vibes-target-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(targetDir, "noir.txt"), "Leaked vibe...\n");
    symlinkSync(targetDir, join(home, ".pi", "agent", "vibes"));

    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
    const { generateVibesBatch, getVibeFileCount, hasVibeFile, initVibeManager, setVibeModel } = await import("../working-vibes.ts");

    assert.equal(hasVibeFile("noir"), false);
    assert.equal(getVibeFileCount("noir"), 0);

    const registration = registerFauxProvider({
      provider: "symlink-test-provider",
      models: [{ id: "symlink-test-model" }],
    });

    try {
      const model = registration.getModel("symlink-test-model");
      assert.ok(model);
      registration.setResponses([fauxAssistantMessage("Fresh vibe...")]);
      initVibeManager({
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === "symlink-test-provider" && modelId === "symlink-test-model" ? model : undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "test-key", headers: {} };
          },
        },
      });
      assert.equal(setVibeModel("symlink-test-provider/symlink-test-model"), true);

      const result = await generateVibesBatch("noir", 1);
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /unsafe path/);
      assert.equal(readFileSync(join(targetDir, "noir.txt"), "utf8"), "Leaked vibe...\n");
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
    rmSync(targetDir, { recursive: true, force: true });
    links.cleanup();
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
    if (process.platform !== "win32") {
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600, "working vibe settings writes should force private file permissions");
    }
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
    const { fauxAssistantMessage, registerFauxProvider } = await importFauxProviderTools();
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

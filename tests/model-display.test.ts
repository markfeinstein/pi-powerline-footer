import test from "node:test";
import assert from "node:assert/strict";
import { NERD_ICONS, setNerdFontsPreference } from "../icons.ts";
import { renderSegment } from "../segments.ts";
import type { SegmentContext } from "../types.ts";

function createSegmentContext(
  model: NonNullable<SegmentContext["model"]>,
  display: "name" | "qualified" = "name",
): SegmentContext {
  return {
    model,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, subagentCost: 0 },
    contextTokens: 0,
    contextPercent: 0,
    contextWindow: 0,
    contextApproximate: false,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    alwaysShowTokens: false,
    queueSummary: {
      queueCount: 0,
      blockedCount: 0,
      compacting: false,
      leadingText: null,
      leadingIntent: null,
      leadingStatus: null,
    },
    sessionStartTime: Date.now(),
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: { model: { display, showThinkingLevel: false } },
    theme: { fg: (_color, text) => text },
    colors: {},
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderModel(
  model: NonNullable<SegmentContext["model"]>,
  display: "name" | "qualified" = "name",
): string {
  return stripAnsi(renderSegment("model", createSegmentContext(model, display)).content);
}

test("model display uses provider icons and compact family-first names", () => {
  const savedOverride = process.env.POWERLINE_NERD_FONTS;
  try {
    delete process.env.POWERLINE_NERD_FONTS;
    setNerdFontsPreference(true);

    assert.equal(
      renderModel({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "github-copilot" }),
      `${NERD_ICONS.providerGithub} Sol 5.6`,
    );
    assert.equal(
      renderModel({ id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "github-copilot" }),
      `${NERD_ICONS.providerGithub} Opus 5.5`,
    );
    assert.equal(
      renderModel({ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex" }),
      `${NERD_ICONS.providerOpenai} Luna 5.6`,
    );
    assert.equal(
      renderModel({ id: "gpt-6.1-terra", name: "GPT-6.1 Terra", providerName: "OpenAI" }),
      `${NERD_ICONS.providerOpenai} Terra 6.1`,
    );
    assert.equal(
      renderModel({ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" }),
      `${NERD_ICONS.providerOpenai} Mini 5.4`,
    );
    assert.equal(
      renderModel({ id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" }),
      `${NERD_ICONS.providerAnthropic} Opus 5.5`,
    );
    assert.equal(
      renderModel({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (latest)", provider: "anthropic" }),
      `${NERD_ICONS.providerAnthropic} Haiku 4.5 (latest)`,
    );
    assert.equal(
      renderModel({ id: "claude-sonnet-5-5", provider: "claude-code" }),
      `${NERD_ICONS.providerAnthropic} Sonnet 5.5`,
    );
    assert.equal(
      renderModel({ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }),
      `${NERD_ICONS.providerOpenai} GPT 4.1`,
    );
    assert.equal(
      renderModel({ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "commandcode" }),
      `${NERD_ICONS.model} DeepSeek V4 Flash`,
    );
  } finally {
    setNerdFontsPreference(null);
    if (savedOverride === undefined) delete process.env.POWERLINE_NERD_FONTS;
    else process.env.POWERLINE_NERD_FONTS = savedOverride;
  }
});

test("qualified model display keeps the exact provider and id", () => {
  const savedOverride = process.env.POWERLINE_NERD_FONTS;
  try {
    delete process.env.POWERLINE_NERD_FONTS;
    setNerdFontsPreference(true);

    assert.equal(
      renderModel(
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex" },
        "qualified",
      ),
      `${NERD_ICONS.providerOpenai} openai-codex/gpt-5.6-sol`,
    );
  } finally {
    setNerdFontsPreference(null);
    if (savedOverride === undefined) delete process.env.POWERLINE_NERD_FONTS;
    else process.env.POWERLINE_NERD_FONTS = savedOverride;
  }
});

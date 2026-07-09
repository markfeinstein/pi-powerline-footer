// working-vibes.ts
// AI-generated contextual working messages that match a user's preferred theme/vibe.
// Uses module-level state (matching powerline-footer pattern).

import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, getAgentPath } from "./paths.ts";
import { stripTerminalControlSequences } from "./powerline-config.ts";

type VibeMode = "generate" | "file";
type CompleteFunction = (model: Model<string>, context: Context, options?: ProviderStreamOptions) => Promise<AssistantMessage>;

let completeFunctionPromise: Promise<CompleteFunction> | null = null;

async function getCompleteFunction(): Promise<CompleteFunction> {
  completeFunctionPromise ??= (async () => {
    const piAi = await import("@earendil-works/pi-ai");
    const complete = Reflect.get(piAi, "complete");
    if (typeof complete === "function") {
      return complete as CompleteFunction;
    }

    const compat = await import("@earendil-works/pi-ai/compat");
    const compatComplete = Reflect.get(compat, "complete");
    if (typeof compatComplete !== "function") {
      throw new Error("pi-ai complete API is unavailable");
    }

    return compatComplete as CompleteFunction;
  })();

  return completeFunctionPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MODEL = "openai-codex/gpt-5.4-mini";
const MAX_VIBE_FILE_BYTES = 128 * 1024;

const DEFAULT_PROMPT = `Generate a 2-4 word "{theme}" themed loading message ending in "...".

Task: {task}

Be creative and unexpected. Avoid obvious/clichéd phrases for this theme.
The message should hint at the task using theme vocabulary.
{exclude}
Output only the message, nothing else.`;

const BATCH_PROMPT = `Generate {count} unique 2-4 word loading messages for a "{theme}" theme.
Each message should end with "..."
Be creative, varied, and thematic. No duplicates.
Output one message per line, nothing else. No numbering, no bullets.`;

const VIBE_SYSTEM_PROMPT = "You generate short themed loading messages and reply with the requested text only.";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface VibeConfig {
  theme: string | null;        // null = disabled
  mode: VibeMode;              // "generate" (on-demand) or "file" (pre-generated)
  modelSpec: string;           // default: "openai-codex/gpt-5.4-mini"
  fallback: string;            // default: "Working"
  timeout: number;             // default: 3000ms
  refreshInterval: number;     // default: 30000ms (30s)
  promptTemplate: string;      // template with {theme}, {task}, {exclude} placeholders
  maxLength: number;           // default: 65 chars
}

interface VibeGenContext {
  theme: string;
  userPrompt: string;          // from event.prompt in before_agent_start
}

// ═══════════════════════════════════════════════════════════════════════════
// Module-level State
// ═══════════════════════════════════════════════════════════════════════════

// Settings are user-edited input. Cap how much we are willing to parse so a huge or
// corrupted ~/.pi/agent/settings.json cannot stall the extension (mirrors index.ts).
// Declared before the loadConfig() call below so it is initialized first (no TDZ).
const MAX_SETTINGS_FILE_BYTES = 256 * 1024;
const DEFAULT_VIBE_BATCH_COUNT = 100;
const MAX_VIBE_BATCH_COUNT = 500;
const MIN_WORKING_VIBE_REFRESH_INTERVAL_MS = 5_000;

let config: VibeConfig = loadConfig();
let extensionCtx: ExtensionContext | null = null;
let currentGeneration: AbortController | null = null;
let isStreaming = false;
let lastVibeTime = 0;
let lastWorkingMessage: string | undefined;
let pendingGeneratedVibe: string | null = null;

// File-based mode state
let vibeCache: string[] = [];        // Cached vibes from file
let vibeCacheTheme: string | null = null;  // Theme the cache is for
let vibeSeed = Date.now();           // Seed for deterministic shuffle
let vibeIndex = 0;                   // Current position in shuffled list

// Recent vibes tracking (to avoid repetition in generate mode)
const MAX_RECENT_VIBES = 5;
let recentVibes: string[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Management
// ═══════════════════════════════════════════════════════════════════════════

function getSettingsPath(): string {
  return getAgentPath("settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeVibeText(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n\t]/g, " ").trim();
}

function sanitizeVibeModelSpec(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_MODEL;
  return sanitizeVibeText(value) || DEFAULT_MODEL;
}

function redactVibeContextText(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n,;]+/gi, "$1[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/(["']?(?:token|secret|password|api[_-]?key|authorization)["']?\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]");
}

function readSettingsForLoad(): Record<string, unknown> {
  const settingsPath = getSettingsPath();

  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const stats = statSync(settingsPath);
    if (!stats.isFile() || stats.size > MAX_SETTINGS_FILE_BYTES) {
      console.debug(`[working-vibes] Ignoring unsafe settings path at ${settingsPath}`);
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[working-vibes] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    console.debug(`[working-vibes] Failed to load settings from ${settingsPath}:`, error);
    return {};
  }
}

function readSettingsForWrite(scope: string): Record<string, unknown> | null {
  const settingsPath = getSettingsPath();

  try {
    const stats = lstatSync(settingsPath);
    if (!stats.isFile()) {
      console.debug(`[working-vibes] Refusing to write ${scope}: settings at ${settingsPath} is not a file`);
      return null;
    }
    if (stats.size > MAX_SETTINGS_FILE_BYTES) {
      console.debug(`[working-vibes] Refusing to write ${scope}: settings at ${settingsPath} is too large`);
      return null;
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[working-vibes] Refusing to write ${scope}: settings at ${settingsPath} is not an object`);
      return null;
    }

    return parsed;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    console.debug(`[working-vibes] Failed to parse settings while writing ${scope} at ${settingsPath}:`, error);
    return null;
  }
}

function persistSettings(settings: Record<string, unknown>, scope: string): boolean {
  const settingsPath = getSettingsPath();

  try {
    if (!canWriteWithinAgentPath(settingsPath)) {
      console.debug(`[working-vibes] Refusing to persist ${scope}: settings path ${settingsPath} has an unsafe parent`);
      return false;
    }

    if (pathExistsOrIsDanglingSymlink(settingsPath) && !lstatSync(settingsPath).isFile()) {
      console.debug(`[working-vibes] Refusing to persist ${scope}: settings at ${settingsPath} is not a file`);
      return false;
    }

    return atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", scope);
  } catch (error) {
    console.debug(`[working-vibes] Failed to persist ${scope} to ${settingsPath}:`, error);
    return false;
  }
}

// Write atomically via a temp file + rename so an interrupted or concurrent
// write can never truncate/corrupt the shared settings or vibe file, and so a
// symlink swapped in after validation cannot redirect the write to an
// arbitrary target (rename replaces the symlink itself rather than following
// it). Mirrors the hardening used in index.ts writePowerlineSetting().
function atomicWriteFile(targetPath: string, contents: string, scope: string, validatePath: (filePath: string) => boolean = canWriteWithinAgentPath): boolean {
  let tempPath = "";
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    if (!validatePath(targetPath)) {
      console.debug(`[working-vibes] Refusing to write ${scope} through unsafe path at ${targetPath}`);
      return false;
    }
    tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, contents, { flag: "wx", mode: 0o600 });
    try {
      if (lstatSync(targetPath).isSymbolicLink()) {
        console.debug(`[working-vibes] Refusing to replace symlinked path while writing ${scope} at ${targetPath}`);
        unlinkSync(tempPath);
        tempPath = "";
        return false;
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        unlinkSync(tempPath);
        tempPath = "";
        throw error;
      }
    }
    renameSync(tempPath, targetPath);
    tempPath = "";
    return true;
  } catch (error) {
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch {
        // best effort cleanup
      }
    }
    console.debug(`[working-vibes] Failed to write ${scope} to ${targetPath}:`, error);
    return false;
  }
}

function pathExistsOrIsDanglingSymlink(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    return !isFileNotFoundError(error);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isSafeWritableDirectoryPath(dirPath: string): boolean {
  try {
    const stats = lstatSync(dirPath);
    return stats.isDirectory();
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function canWriteWithinAgentPath(filePath: string): boolean {
  const agentDir = getAgentDir();
  const targetDir = dirname(filePath);
  if (!isSafeWritableDirectoryPath(dirname(agentDir)) || !isSafeWritableDirectoryPath(agentDir)) return false;

  // Allow writes directly under the agent dir or under agent-dir/vibes even if
  // the vibes directory does not exist yet. atomicWriteFile() creates the parent
  // directory after the path has been validated.
  if (targetDir === agentDir) return true;

  const vibesDir = join(agentDir, "vibes");
  return targetDir === vibesDir && isSafeWritableDirectoryPath(vibesDir);
}

function canWriteRegularFilePath(filePath: string): boolean {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile();
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function loadConfig(): VibeConfig {
  const settings = readSettingsForLoad();

  // Handle "off" in settings.json (same as null/disabled)
  const rawTheme = typeof settings.workingVibe === "string" ? sanitizeVibeText(settings.workingVibe) : null;
  const theme = rawTheme?.toLowerCase() === "off" ? null : rawTheme;

  // Validate mode setting
  const rawMode = settings.workingVibeMode;
  const mode: VibeMode = rawMode === "file" || rawMode === "generate" ? rawMode : "generate";

  const refreshSeconds =
    typeof settings.workingVibeRefreshInterval === "number" && Number.isFinite(settings.workingVibeRefreshInterval)
      ? Math.max(MIN_WORKING_VIBE_REFRESH_INTERVAL_MS / 1000, settings.workingVibeRefreshInterval)
      : 30;

  const maxLength =
    typeof settings.workingVibeMaxLength === "number" && Number.isFinite(settings.workingVibeMaxLength)
      ? Math.max(4, Math.floor(settings.workingVibeMaxLength))
      : 65;

  return {
    theme,
    mode,
    modelSpec: sanitizeVibeModelSpec(settings.workingVibeModel),
    fallback: typeof settings.workingVibeFallback === "string" ? sanitizeVibeText(settings.workingVibeFallback) || "Working" : "Working",
    timeout: 3000,
    refreshInterval: refreshSeconds * 1000,
    promptTemplate: typeof settings.workingVibePrompt === "string" ? settings.workingVibePrompt : DEFAULT_PROMPT,
    maxLength,
  };
}

function saveConfig(): boolean {
  const settings = readSettingsForWrite("workingVibe");
  if (!settings) {
    return false;
  }

  if (config.theme === null) {
    delete settings.workingVibe;
  } else {
    settings.workingVibe = config.theme;
  }

  return persistSettings(settings, "workingVibe");
}

function saveModelConfig(): boolean {
  const settings = readSettingsForWrite("workingVibeModel");
  if (!settings) {
    return false;
  }

  if (config.modelSpec === DEFAULT_MODEL) {
    delete settings.workingVibeModel;
  } else {
    settings.workingVibeModel = config.modelSpec;
  }

  return persistSettings(settings, "workingVibeModel");
}

function normalizeVibeBatchCount(count: unknown): number {
  return typeof count === "number" && Number.isFinite(count)
    ? Math.min(Math.max(Math.floor(count), 1), MAX_VIBE_BATCH_COUNT)
    : DEFAULT_VIBE_BATCH_COUNT;
}

export interface ParsedVibeGenerateArgs {
  theme: string;
  count: number;
}

export function parseVibeGenerateArgs(args: readonly string[]): ParsedVibeGenerateArgs | null {
  const tokens = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  if (tokens.length === 0) return null;

  const lastToken = tokens[tokens.length - 1] ?? "";
  const hasExplicitCount = tokens.length > 1 && /^\d+$/.test(lastToken);
  const parsedCount = hasExplicitCount ? Number.parseInt(lastToken, 10) : DEFAULT_VIBE_BATCH_COUNT;
  const theme = (hasExplicitCount ? tokens.slice(0, -1) : tokens).join(" ").trim();
  if (!theme) return null;

  return {
    theme,
    count: hasExplicitCount ? normalizeVibeBatchCount(parsedCount) : DEFAULT_VIBE_BATCH_COUNT,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// File-Based Vibe Management
// ═══════════════════════════════════════════════════════════════════════════

function getVibesDir(): string {
  return getAgentPath("vibes");
}

function toVibeFileSlug(theme: string): string {
  const normalizedTheme = theme.trim().toLowerCase();
  const slug = normalizedTheme
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (slug && !/[^\x00-\x7f]/.test(normalizedTheme)) {
    return slug;
  }

  const hash = createHash("sha256").update(normalizedTheme || theme).digest("hex").slice(0, 8);
  return `${slug || "theme"}-${hash}`;
}

function getVibeFilePath(theme: string): string {
  const filename = `${toVibeFileSlug(theme)}.txt`;
  return join(getVibesDir(), filename);
}

function loadVibesFromFile(theme: string): string[] {
  const filePath = getVibeFilePath(theme);

  try {
    if (!canWriteWithinAgentPath(filePath)) return [];
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.size > MAX_VIBE_FILE_BYTES) return [];
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => sanitizeVibeText(line))
      .filter(line => line.length > 0 && line.endsWith("..."));
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      console.debug(`[working-vibes] Failed to load vibe file ${filePath}:`, error);
    }
    return [];
  }
}

function saveVibesToFile(theme: string, vibes: string[]): void {
  const filePath = getVibeFilePath(theme);

  if (!canWriteWithinAgentPath(filePath)) {
    throw new Error(`Refusing to write vibe file through unsafe path: ${filePath}`);
  }

  if (pathExistsOrIsDanglingSymlink(filePath) && !canWriteRegularFilePath(filePath)) {
    throw new Error(`Refusing to write vibe file through unsafe path: ${filePath}`);
  }

  if (!atomicWriteFile(filePath, vibes.join("\n"), "vibe file")) {
    throw new Error(`Refusing to write vibe file through unsafe path: ${filePath}`);
  }
}

// Mulberry32 PRNG - fast, deterministic, good distribution
function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Get vibe at index using seeded shuffle (no-repeat until all used)
function getVibeAtIndex(vibes: string[], index: number, seed: number): string {
  if (vibes.length === 0) return `${config.fallback}...`;
  
  // For small lists or when we've cycled through, just use modulo
  const effectiveIndex = index % vibes.length;
  
  // Create deterministic shuffle using seed
  const rng = mulberry32(seed);
  const indices = Array.from({ length: vibes.length }, (_, i) => i);
  
  // Fisher-Yates shuffle with seeded RNG
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  
  return vibes[indices[effectiveIndex]];
}

function getNextVibeFromFile(): string {
  if (!config.theme) return `${config.fallback}...`;
  
  // Load/reload cache if theme changed
  if (vibeCacheTheme !== config.theme) {
    vibeCache = loadVibesFromFile(config.theme);
    vibeCacheTheme = config.theme;
    vibeSeed = Date.now();  // New seed for new theme
    vibeIndex = 0;
  }
  
  if (vibeCache.length === 0) {
    return `${config.fallback}...`;
  }
  
  const vibe = getVibeAtIndex(vibeCache, vibeIndex, vibeSeed);
  vibeIndex++;
  return vibe;
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt Building & Response Parsing (Pure Functions)
// ═══════════════════════════════════════════════════════════════════════════

function buildVibePrompt(ctx: VibeGenContext): string {
  // Truncate user prompt to save tokens (most context in first 100 chars)
  const task = redactVibeContextText(ctx.userPrompt).slice(0, 100);
  
  // Build exclusion list from recent vibes
  const exclude = recentVibes.length > 0 
    ? `Don't use: ${recentVibes.join(", ")}`
    : "";
  
  // Use configured template with variable substitution
  return config.promptTemplate
    .replace(/\{theme\}/g, ctx.theme)
    .replace(/\{task\}/g, task)
    .replace(/\{exclude\}/g, exclude);
}

function truncateVibeText(vibe: string, maxLength: number): string {
  if (vibe.length <= maxLength) return vibe;
  return Array.from(vibe).slice(0, Math.max(0, maxLength - 3)).join("") + "...";
}

function parseVibeResponse(response: string, fallback: string): string {
  if (!response) return `${fallback}...`;
  
  // Take only the first line (AI sometimes adds explanations)
  let vibe = sanitizeVibeText(response.trim().split('\n')[0] ?? "");
  
  // Remove quotes if model wrapped the response
  vibe = sanitizeVibeText(vibe.replace(/^["']|["']$/g, ""));
  
  // Ensure ellipsis
  if (!vibe.endsWith("...")) {
    vibe = vibe.replace(/\.+$/, "") + "...";
  }
  
  // Enforce length limit (configurable, default 65 chars)
  if (vibe.length > config.maxLength) {
    vibe = truncateVibeText(vibe, config.maxLength);
  }
  
  // Final validation
  if (!vibe || vibe === "...") {
    return `${fallback}...`;
  }
  
  return vibe;
}

function buildAiContext(prompt: string): Context {
  return {
    systemPrompt: VIBE_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Generation
// ═══════════════════════════════════════════════════════════════════════════

async function generateVibe(
  ctx: VibeGenContext,
  signal: AbortSignal,
): Promise<string> {
  if (!extensionCtx) {
    return `${config.fallback}...`;
  }
  
  // Parse model spec (provider/modelId format, where modelId may contain slashes)
  const slashIndex = config.modelSpec.indexOf("/");
  if (slashIndex === -1) {
    return `${config.fallback}...`;
  }
  const provider = config.modelSpec.slice(0, slashIndex);
  const modelId = config.modelSpec.slice(slashIndex + 1);
  if (!provider || !modelId) {
    return `${config.fallback}...`;
  }
  
  // Resolve model from registry
  const model = extensionCtx.modelRegistry.find(provider, modelId);
  if (!model) {
    console.debug(`[working-vibes] Model not found: ${config.modelSpec}`);
    return `${config.fallback}...`;
  }
  
  // Get auth
  const auth = await extensionCtx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    console.debug(`[working-vibes] Auth failed for ${provider}: ${auth.error}`);
    return `${config.fallback}...`;
  }
  
  const aiContext = buildAiContext(buildVibePrompt(ctx));
  const complete = await getCompleteFunction();
  const response = await complete(model, aiContext, { apiKey: auth.apiKey, headers: auth.headers, signal });

  const textContent = response.content.find(c => c.type === "text");
  if (!textContent?.text && response.stopReason === "error" && response.errorMessage) {
    console.debug(`[working-vibes] Vibe generation failed for ${config.modelSpec}: ${response.errorMessage}`);
  }
  return parseVibeResponse(textContent?.text || "", config.fallback);
}

function trackRecentVibe(vibe: string): void {
  // Don't track fallback messages
  if (vibe === `${config.fallback}...`) return;
  
  // Add to front, remove duplicates
  recentVibes = [vibe, ...recentVibes.filter(v => v !== vibe)].slice(0, MAX_RECENT_VIBES);
}

function setWorkingMessageIfChanged(setWorkingMessage: (msg?: string) => void, message: string | undefined): void {
  if (lastWorkingMessage === message) return;
  setWorkingMessage(message);
  lastWorkingMessage = message;
}

function updateVibeFromFile(setWorkingMessage: (msg?: string) => void): void {
  setWorkingMessageIfChanged(setWorkingMessage, getNextVibeFromFile());
}

function applyGeneratedVibe(setWorkingMessage: (msg?: string) => void, vibe: string): void {
  trackRecentVibe(vibe);
  setWorkingMessageIfChanged(setWorkingMessage, vibe);
}

async function generateAndUpdate(
  prompt: string, 
  setWorkingMessage: (msg?: string) => void,
): Promise<void> {
  // File mode: instant, no API call
  if (config.mode === "file") {
    updateVibeFromFile(setWorkingMessage);
    return;
  }
  
  // Generate mode: API call with abort handling
  // Cancel any in-flight generation and create new controller
  // Capture in local variable to avoid race condition with subsequent calls
  const controller = new AbortController();
  currentGeneration?.abort();
  currentGeneration = controller;
  
  // Create timeout signal (3 seconds)
  const timeoutSignal = AbortSignal.timeout(config.timeout);
  const combinedSignal = AbortSignal.any([
    controller.signal,
    timeoutSignal,
  ]);
  
  try {
    const vibe = await generateVibe(
      { theme: config.theme!, userPrompt: prompt },
      combinedSignal,
    );
    
    // Only update if THIS generation wasn't aborted. When before_agent_start
    // generation wins the race against agent_start, keep the result for the
    // loader instead of leaving the placeholder up for the whole turn.
    if (!controller.signal.aborted) {
      if (isStreaming) {
        applyGeneratedVibe(setWorkingMessage, vibe);
      } else {
        pendingGeneratedVibe = vibe;
      }
    }
  } catch (error) {
    // AbortError is expected on timeout/cancel - don't log as error
    if (error instanceof Error && error.name === "AbortError") {
      console.debug("[working-vibes] Generation aborted");
    } else {
      console.debug("[working-vibes] Generation failed:", error);
    }
    // Fallback already showing, no action needed
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Exported Functions (called from index.ts)
// ═══════════════════════════════════════════════════════════════════════════

export function initVibeManager(ctx: ExtensionContext): void {
  extensionCtx = ctx;
  config = loadConfig(); // Refresh config in case settings changed
  currentGeneration?.abort();
  currentGeneration = null;
  isStreaming = false;
  lastVibeTime = 0;
  lastWorkingMessage = undefined;
  pendingGeneratedVibe = null;
  vibeCache = [];
  vibeCacheTheme = null;
  vibeSeed = Date.now();
  vibeIndex = 0;
}

export function getVibeTheme(): string | null {
  return config.theme;
}

export function setVibeTheme(theme: string | null): boolean {
  config = { ...config, theme: theme === null ? null : sanitizeVibeText(theme) };
  recentVibes = [];  // Clear recent vibes on theme change
  return saveConfig();
}

export function getVibeModel(): string {
  return config.modelSpec;
}

export function setVibeModel(modelSpec: string): boolean {
  config = { ...config, modelSpec: sanitizeVibeModelSpec(modelSpec) };
  return saveModelConfig();
}

export function onVibeBeforeAgentStart(
  prompt: string, 
  setWorkingMessage: (msg?: string) => void,
): void {
  // Skip if no theme configured or no extensionCtx
  if (!config.theme || !extensionCtx) return;
  
  // Queue themed placeholder BEFORE agent_start creates the loader.
  setWorkingMessageIfChanged(setWorkingMessage, `Channeling ${config.theme}...`);
  pendingGeneratedVibe = null;
  
  // Mark vibe generation time for rate limiting
  lastVibeTime = Date.now();
  
  // Async: generate and update (fire-and-forget, don't await)
  generateAndUpdate(prompt, setWorkingMessage);
}

export function onVibeAgentStart(setWorkingMessage?: (msg?: string) => void): void {
  isStreaming = true;
  if (pendingGeneratedVibe && setWorkingMessage) {
    const vibe = pendingGeneratedVibe;
    pendingGeneratedVibe = null;
    applyGeneratedVibe(setWorkingMessage, vibe);
  }
}

export function onVibeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  setWorkingMessage: (msg?: string) => void,
  agentContext?: string,  // Optional: recent agent response text for richer context
): void {
  // Skip if no theme, not streaming, or no extensionCtx
  if (!config.theme || !extensionCtx || !isStreaming) return;
  
  // Rate limit: skip if not enough time has passed
  const now = Date.now();
  if (now - lastVibeTime < config.refreshInterval) return;
  
  // Prefer agent context if provided (richer, more contextual)
  // Fall back to tool-based hint
  let hint: string;
  if (agentContext && agentContext.length > 10) {
    // Use first ~150 chars of agent context
    hint = redactVibeContextText(agentContext).slice(0, 150);
  } else {
    // Build hint from tool name and input
    hint = `using ${toolName} tool`;
    if (toolName === "read" && toolInput.path) {
      hint = `reading file: ${redactVibeContextText(String(toolInput.path))}`;
    } else if (toolName === "write" && toolInput.path) {
      hint = `writing file: ${redactVibeContextText(String(toolInput.path))}`;
    } else if (toolName === "edit" && toolInput.path) {
      hint = `editing file: ${redactVibeContextText(String(toolInput.path))}`;
    } else if (toolName === "bash" && toolInput.command) {
      const cmd = redactVibeContextText(String(toolInput.command)).slice(0, 40);
      hint = `running command: ${cmd}`;
    }
  }
  
  // Update time and generate new vibe
  lastVibeTime = now;
  generateAndUpdate(hint, setWorkingMessage);
}

export function onVibeAgentEnd(setWorkingMessage: (msg?: string) => void): void {
  isStreaming = false;
  // Cancel any in-flight generation
  currentGeneration?.abort();
  currentGeneration = null;
  pendingGeneratedVibe = null;
  // Reset to pi's default working message.
  setWorkingMessageIfChanged(setWorkingMessage, undefined);
}

export function getVibeMode(): VibeMode {
  return config.mode;
}

export function setVibeMode(mode: VibeMode): boolean {
  config = { ...config, mode };
  return saveModeConfig();
}

function saveModeConfig(): boolean {
  const settings = readSettingsForWrite("workingVibeMode");
  if (!settings) {
    return false;
  }

  if (config.mode === "generate") {
    delete settings.workingVibeMode;
  } else {
    settings.workingVibeMode = config.mode;
  }

  return persistSettings(settings, "workingVibeMode");
}

export function hasVibeFile(theme: string): boolean {
  return loadVibesFromFile(theme).length > 0;
}

export function getVibeFileCount(theme: string): number {
  const vibes = loadVibesFromFile(theme);
  return vibes.length;
}

export interface GenerateVibesResult {
  success: boolean;
  count: number;
  filePath: string;
  error?: string;
}

export async function generateVibesBatch(
  theme: string,
  count: number = 100,
): Promise<GenerateVibesResult> {
  const filePath = getVibeFilePath(theme);
  const safeCount = normalizeVibeBatchCount(count);
  
  if (!extensionCtx) {
    return { success: false, count: 0, filePath, error: "Extension not initialized" };
  }
  
  // Parse model spec
  const slashIndex = config.modelSpec.indexOf("/");
  if (slashIndex === -1) {
    return { success: false, count: 0, filePath, error: "Invalid model spec" };
  }
  const provider = config.modelSpec.slice(0, slashIndex);
  const modelId = config.modelSpec.slice(slashIndex + 1);
  
  // Resolve model
  const model = extensionCtx.modelRegistry.find(provider, modelId);
  if (!model) {
    return { success: false, count: 0, filePath, error: `Model not found: ${config.modelSpec}` };
  }
  
  // Get auth
  const auth = await extensionCtx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { success: false, count: 0, filePath, error: auth.error };
  }
  
  // Build batch prompt
  const prompt = BATCH_PROMPT
    .replace(/\{theme\}/g, theme)
    .replace(/\{count\}/g, String(safeCount));
  
  const aiContext = buildAiContext(prompt);
  
  try {
    // Use longer timeout for batch generation (30 seconds)
    const signal = AbortSignal.timeout(30000);
    const complete = await getCompleteFunction();
    const response = await complete(model, aiContext, { apiKey: auth.apiKey, headers: auth.headers, signal });
    
    const textContent = response.content.find(c => c.type === "text");
    if (!textContent?.text) {
      const error = response.stopReason === "error" && response.errorMessage
        ? response.errorMessage
        : "Empty response from model";
      return { success: false, count: 0, filePath, error };
    }
    
    // Parse response: one vibe per line
    const parsedVibes = textContent.text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        // Clean up each line
        let vibe = sanitizeVibeText(line.replace(/^["'\d.\-)\s]+/, ""));  // Remove leading quotes, numbers, bullets
        vibe = sanitizeVibeText(vibe.replace(/["']$/g, ""));  // Remove trailing quotes
        if (!vibe.endsWith("...")) {
          vibe = vibe.replace(/\.+$/, "") + "...";
        }
        return vibe;
      })
      .filter(vibe => vibe.length > 3 && vibe !== "...");  // Filter invalid
    const vibes = [...new Set(parsedVibes)].slice(0, safeCount);
    
    if (vibes.length === 0) {
      return { success: false, count: 0, filePath, error: "No valid vibes generated" };
    }
    
    // Save to file
    saveVibesToFile(theme, vibes);
    
    // Clear cache so next use loads fresh
    if (vibeCacheTheme === theme) {
      vibeCache = [];
      vibeCacheTheme = null;
    }
    
    return { success: true, count: vibes.length, filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, count: 0, filePath, error: message };
  }
}

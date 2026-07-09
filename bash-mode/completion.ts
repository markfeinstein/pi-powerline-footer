import { opendirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { containsShellHistorySecret, matchHistoryEntries, readGlobalShellHistory, readProjectHistory } from "./history.ts";
import type { ExtendedCompletionItem, GhostSuggestion } from "./types.ts";

interface TokenContext {
  line: string;
  cursorCol: number;
  beforeCursor: string;
  afterCursor: string;
  token: string;
  tokenStart: number;
  tokenEnd: number;
  tokenIndex: number;
  previousTokens: string[];
}

export interface OneOffBashCommandContext {
  prefix: string;
  command: string;
  offset: number;
}

const GIT_SUBCOMMANDS = [
  "add", "bisect", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "diff", "fetch",
  "grep", "init", "log", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm",
  "show", "stash", "status", "switch", "tag", "worktree",
];
const GIT_REF_CACHE_TTL_MS = 5_000;
const GIT_COMPLETION_TIMEOUT_MS = 250;
const GIT_COMPLETION_MAX_BUFFER = 256 * 1024;
const PATH_COMPLETION_MAX_RESULTS = 100;
const PATH_COMPLETION_MAX_SCAN_ENTRIES = 2000;
const gitRefsCache = new Map<string, { at: number; refs: string[] }>();

function tokenizeBeforeCursor(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function findShellTokenStart(beforeCursor: string): number {
  let tokenStart = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < beforeCursor.length; i += 1) {
    const char = beforeCursor[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      tokenStart = i + 1;
    }
  }

  return tokenStart;
}

function findShellTokenEnd(line: string, cursorCol: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenEnd = cursorCol;

  for (let i = findShellTokenStart(line.slice(0, cursorCol)); i < line.length; i += 1) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
      tokenEnd = i + 1;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      tokenEnd = i + 1;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      tokenEnd = i + 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenEnd = i + 1;
      continue;
    }

    if (/\s/.test(char)) break;
    tokenEnd = i + 1;
  }

  return tokenEnd;
}

function getTokenContext(line: string, cursorCol: number): TokenContext {
  const beforeCursor = line.slice(0, cursorCol);
  const afterCursor = line.slice(cursorCol);
  const tokens = tokenizeBeforeCursor(beforeCursor);
  const tokenStart = findShellTokenStart(beforeCursor);
  const tokenEnd = findShellTokenEnd(line, cursorCol);

  const tokenIndex = beforeCursor.length > 0 && /\s/.test(beforeCursor[beforeCursor.length - 1] ?? "")
    ? tokens.length
    : Math.max(0, tokens.length - 1);

  return {
    line,
    cursorCol,
    beforeCursor,
    afterCursor,
    token: line.slice(tokenStart, tokenEnd),
    tokenStart,
    tokenEnd,
    tokenIndex,
    previousTokens: tokens,
  };
}

export function getOneOffBashCommandContext(line: string): OneOffBashCommandContext | null {
  if (line.startsWith("!!")) {
    return {
      prefix: "!!",
      command: line.slice(2),
      offset: 2,
    };
  }

  if (line.startsWith("!")) {
    return {
      prefix: "!",
      command: line.slice(1),
      offset: 1,
    };
  }

  return null;
}

function supportsShouldTriggerFileCompletion(
  provider: AutocompleteProvider,
): provider is AutocompleteProvider & {
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean;
} {
  return "shouldTriggerFileCompletion" in provider && typeof provider.shouldTriggerFileCompletion === "function";
}

function isExtendedCompletionItem(item: AutocompleteItem): item is ExtendedCompletionItem {
  return "replacement" in item
    && typeof item.replacement === "string"
    && "startCol" in item
    && typeof item.startCol === "number"
    && "endCol" in item
    && typeof item.endCol === "number";
}

function uniqueByReplacement(items: ExtendedCompletionItem[]): ExtendedCompletionItem[] {
  const best = new Map<string, ExtendedCompletionItem>();
  for (const item of items) {
    const key = `${item.startCol}:${item.endCol}:${item.replacement}`;
    const existing = best.get(key);
    if (!existing || item.score > existing.score) {
      best.set(key, item);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function unescapeShellPathToken(token: string): { path: string; quote: "'" | '"' | null } {
  const quote = token[0] === "'" || token[0] === '"' ? token[0] : null;
  const raw = quote ? token.slice(1) : token;
  const value = quote && raw.endsWith(quote) ? raw.slice(0, -1) : raw;

  if (quote === "'") {
    return { path: value, quote };
  }

  return {
    path: value.replace(/\\(.)/g, "$1"),
    quote,
  };
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function pathBase(token: string, cwd: string): { dir: string; prefix: string; displayPrefix: string; quote: "'" | '"' | null } {
  const parsed = unescapeShellPathToken(token);
  const expanded = !parsed.quote && parsed.path.startsWith("~/")
    ? join(getHomeDir(), parsed.path.slice(2))
    : parsed.path;

  const hasDirectoryPart = expanded.includes("/") || (sep === "\\" && expanded.includes("\\"));
  if (!hasDirectoryPart) {
    return { dir: cwd, prefix: expanded, displayPrefix: parsed.quote ?? "", quote: parsed.quote };
  }

  const hasTrailingDirectorySeparator = parsed.path.endsWith("/") || expanded.endsWith("/");
  const baseDir = hasTrailingDirectorySeparator ? expanded : dirname(expanded);
  const resolvedDir = isAbsolute(baseDir) ? baseDir : resolve(cwd, baseDir);
  const prefix = hasTrailingDirectorySeparator ? "" : basename(expanded);
  const tokenSlashIndex = token.lastIndexOf("/");
  const displayPrefix = tokenSlashIndex === -1
    ? (parsed.quote ?? "")
    : token.slice(0, token.endsWith("/") ? token.length : tokenSlashIndex + 1);
  return { dir: resolvedDir, prefix, displayPrefix, quote: parsed.quote };
}

function escapeShellPath(value: string): string {
  return value.replace(/([\\\s"'`$&|;<>()[\]{}?!*#])/g, "\\$1");
}

function escapeQuotedPathSegment(value: string, quote: "'" | '"'): string {
  if (quote === "'") {
    return value.replace(/'/g, `'\\''`);
  }
  return value.replace(/(["\\$`])/g, "\\$1");
}

function getPathSuggestions(token: string, cwd: string): ExtendedCompletionItem[] {
  if (!token) return [];
  const { dir, prefix, displayPrefix, quote } = pathBase(token, cwd);
  const items: ExtendedCompletionItem[] = [];
  let handle: ReturnType<typeof opendirSync> | null = null;

  try {
    handle = opendirSync(dir);
    let scanned = 0;
    let entry: Dirent | null;
    while (
      items.length < PATH_COMPLETION_MAX_RESULTS &&
      scanned < PATH_COMPLETION_MAX_SCAN_ENTRIES &&
      (entry = handle.readSync()) !== null
    ) {
      scanned++;
      if (prefix.length > 0 && !entry.name.startsWith(prefix)) continue;

      const suffix = entry.isDirectory() ? "/" : "";
      const label = `${displayPrefix}${entry.name}${suffix}`;
      const escapedName = quote ? escapeQuotedPathSegment(entry.name, quote) : escapeShellPath(entry.name);
      const replacement = `${displayPrefix}${escapedName}${suffix}`;
      items.push({
        value: replacement,
        label,
        replacement,
        startCol: 0,
        endCol: 0,
        source: "path",
        score: 40 + (entry.isDirectory() ? 4 : 0),
      });
    }

    return items;
  } catch {
    // Missing or unreadable directories should only remove this completion source.
    return [];
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // Best effort; completions should not fail because closing a directory handle failed.
    }
  }
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return [];

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timedOut = false;
    let child: ChildProcessByStdio<null, Readable, null> | null = null;

    const killProcessGroup = () => {
      if (!child || child.pid === undefined) return;
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have already exited.
        }
      }
    };

    const finish = (lines: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(lines);
    };

    const onAbort = () => {
      killProcessGroup();
      finish([]);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
      finish([]);
    }, GIT_COMPLETION_TIMEOUT_MS);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      child = spawn("git", args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish([]);
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > GIT_COMPLETION_MAX_BUFFER) {
        killProcessGroup();
        finish([]);
      }
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (timedOut || code !== 0 || !stdout) {
        finish([]);
        return;
      }
      finish(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function getGitRefs(cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return [];

  const now = Date.now();
  const cached = gitRefsCache.get(cwd);
  if (cached && now - cached.at < GIT_REF_CACHE_TTL_MS) {
    return cached.refs;
  }

  const refs = [
    ...await runGit(["branch", "--format=%(refname:short)"], cwd, signal),
    ...await runGit(["tag", "--list"], cwd, signal),
  ];
  const deduped = [...new Set(refs)];
  if (!signal?.aborted) {
    gitRefsCache.set(cwd, { at: now, refs: deduped });
  }
  return deduped;
}

async function getGitSuggestions(ctx: TokenContext, cwd: string, signal?: AbortSignal): Promise<ExtendedCompletionItem[]> {
  const tokens = ctx.previousTokens;
  if (tokens[0] !== "git") return [];

  if (ctx.tokenIndex <= 1) {
    return GIT_SUBCOMMANDS
      .filter((command) => command.startsWith(ctx.token))
      .map((command) => ({
        value: command,
        label: command,
        replacement: command,
        startCol: 0,
        endCol: 0,
        source: "git",
        score: 52,
      }));
  }

  const subcommand = tokens[1] ?? "";
  if (!["checkout", "switch", "merge", "rebase", "branch", "show", "diff"].includes(subcommand)) {
    return [];
  }

  const tokenPrefix = unescapeShellPathToken(ctx.token).path;
  if (signal?.aborted) return [];

  return (await getGitRefs(cwd, signal))
    .filter((ref) => !signal?.aborted && !ref.startsWith("-") && ref.startsWith(tokenPrefix))
    .slice(0, 100)
    .map((ref) => ({
      value: ref,
      label: ref,
      replacement: escapeShellPath(ref),
      startCol: 0,
      endCol: 0,
      source: "git",
      score: 50,
    }));
}

function canUseHistorySuggestion(ctx: TokenContext): boolean {
  return ctx.cursorCol === ctx.line.length && ctx.line.trim().length > 0;
}

function withRange(items: ExtendedCompletionItem[], startCol: number, endCol: number): ExtendedCompletionItem[] {
  return items.map((item) => ({ ...item, startCol, endCol }));
}

function applyCompletionToLine(line: string, item: ExtendedCompletionItem): string {
  return line.slice(0, item.startCol) + item.replacement + line.slice(item.endCol);
}

function commandHead(value: string): string {
  return tokenizeBeforeCursor(value.trim())[0] ?? "";
}

function findNewestHistoryMatchForHead(entries: string[], prefix: string, head: string): string | null {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry || !entry.startsWith(prefix) || containsShellHistorySecret(entry)) continue;
    if (commandHead(entry) !== head) continue;
    return entry;
  }
  return null;
}

function getCuratedCommandFallback(prefix: string): GhostSuggestion | null {
  const trimmed = prefix.trim();
  if (!trimmed) return null;

  if ("cd".startsWith(trimmed)) {
    return { value: "cd ..", source: "path" };
  }

  if ("git".startsWith(trimmed)) {
    return { value: "git status", source: "git" };
  }

  return null;
}

function isLikelyGitCommandHead(prefix: string): boolean {
  const trimmed = prefix.trim();
  return trimmed.length >= 2 && "git".startsWith(trimmed);
}

function boostValidatedItemsFromGlobalHistory(
  line: string,
  items: ExtendedCompletionItem[],
  globalHistoryMatches: string[],
): ExtendedCompletionItem[] {
  if (items.length === 0 || globalHistoryMatches.length === 0) {
    return items;
  }

  const boosts = new Map<string, number>();
  for (const [index, value] of globalHistoryMatches.entries()) {
    boosts.set(value, Math.max(1, 4 - index));
  }

  return items.map((item) => {
    const boost = boosts.get(applyCompletionToLine(line, item));
    return boost ? { ...item, score: item.score + boost } : item;
  });
}

export class BashCompletionEngine {
  async getGhostSuggestion(line: string, cwd: string, shellPath: string, signal: AbortSignal): Promise<GhostSuggestion | null> {
    const projectHistoryEntries = readProjectHistory(cwd);

    if (line.trim().length === 0) {
      const prefix = line;
      const projectHistory = matchHistoryEntries(
        projectHistoryEntries.map((entry) => entry.command),
        line,
        1,
      );
      if (projectHistory.length > 0) {
        return { value: `${prefix}${projectHistory[0]!}`, source: "project-history" };
      }

      return null;
    }

    const ctx = getTokenContext(line, line.length);
    if (!canUseHistorySuggestion(ctx)) return null;

    const projectHistory = matchHistoryEntries(
      projectHistoryEntries.map((entry) => entry.command),
      line,
      10,
    );
    if (projectHistory.length > 0) {
      return { value: projectHistory[0]!, source: "project-history" };
    }

    if (ctx.tokenIndex === 0) {
      return this.getCommandPositionGhostSuggestion(line, readGlobalShellHistory(shellPath));
    }

    if (signal.aborted) return null;

    const deterministic = await this.getDeterministicInlineSuggestions(ctx, cwd, signal);
    if (signal.aborted) return null;
    const globalHistory = matchHistoryEntries(readGlobalShellHistory(shellPath), line, 5);
    const ranked = boostValidatedItemsFromGlobalHistory(
      line,
      uniqueByReplacement(deterministic),
      globalHistory,
    );

    for (const item of ranked) {
      const value = this.buildInlineSuggestionValue(line, item);
      if (value) {
        return { value, source: item.source };
      }
    }

    return null;
  }

  private getCommandPositionGhostSuggestion(
    line: string,
    globalHistoryEntries: string[],
  ): GhostSuggestion | null {
    if (isLikelyGitCommandHead(line)) {
      const globalMatch = findNewestHistoryMatchForHead(globalHistoryEntries, line, "git");
      if (globalMatch) {
        return { value: globalMatch, source: "global-history" };
      }
    }

    return getCuratedCommandFallback(line);
  }

  private async getDeterministicInlineSuggestions(ctx: TokenContext, cwd: string, signal?: AbortSignal): Promise<ExtendedCompletionItem[]> {
    const items: ExtendedCompletionItem[] = [];
    items.push(...withRange(await getGitSuggestions(ctx, cwd, signal), ctx.tokenStart, ctx.tokenEnd));
    if (signal?.aborted) return [];
    items.push(...withRange(getPathSuggestions(ctx.token, cwd), ctx.tokenStart, ctx.tokenEnd));

    return uniqueByReplacement(items);
  }

  private buildInlineSuggestionValue(line: string, item: ExtendedCompletionItem): string | null {
    const value = applyCompletionToLine(line, item);
    if (!value.startsWith(line) || value === line) {
      return null;
    }
    return value;
  }

}

export class BashAutocompleteProvider implements AutocompleteProvider {
  getSuggestions(): AutocompleteSuggestions | null {
    return null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (!isExtendedCompletionItem(item)) {
      throw new Error("Expected an extended completion item for bash autocomplete");
    }

    return applyExtendedCompletion(lines, cursorLine, item);
  }

  shouldTriggerFileCompletion(): boolean {
    return false;
  }
}

function applyExtendedCompletion(lines: string[], cursorLine: number, item: ExtendedCompletionItem): {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
} {
  const currentLine = lines[cursorLine] || "";
  const startCol = Math.max(0, Math.min(item.startCol, currentLine.length));
  const endCol = Math.max(startCol, Math.min(item.endCol, currentLine.length));
  const nextLine = currentLine.slice(0, startCol) + item.replacement + currentLine.slice(endCol);
  const nextLines = [...lines];
  nextLines[cursorLine] = nextLine;
  return {
    lines: nextLines,
    cursorLine,
    cursorCol: startCol + item.replacement.length,
  };
}

export class OneOffBashAutocompleteProvider implements AutocompleteProvider {
  getSuggestions(): AutocompleteSuggestions | null {
    return null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (!isExtendedCompletionItem(item)) {
      throw new Error("Expected an extended completion item for one-off bash autocomplete");
    }

    return applyExtendedCompletion(lines, cursorLine, item);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const bang = cursorLine === 0 ? getOneOffBashCommandContext(lines[0] || "") : null;
    return bang !== null && cursorCol >= bang.offset;
  }
}

function getProviderTriggerCharacters(provider: AutocompleteProvider | undefined): string[] {
  const candidate = provider && typeof provider === "object" ? Reflect.get(provider, "triggerCharacters") : undefined;
  return Array.isArray(candidate)
    ? candidate.filter((character): character is string => typeof character === "string" && character.length === 1)
    : [];
}

export class ModeAwareAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[];
  private readonly defaultProvider: AutocompleteProvider | undefined;
  private readonly bashProvider: AutocompleteProvider;
  private readonly oneOffBashProvider: AutocompleteProvider;
  private readonly isBashModeActive: () => boolean;

  constructor(
    defaultProvider: AutocompleteProvider | undefined,
    bashProvider: AutocompleteProvider,
    oneOffBashProvider: AutocompleteProvider,
    isBashModeActive: () => boolean,
  ) {
    this.defaultProvider = defaultProvider;
    this.bashProvider = bashProvider;
    this.oneOffBashProvider = oneOffBashProvider;
    this.isBashModeActive = isBashModeActive;
    this.triggerCharacters = [
      ...new Set([
        ...getProviderTriggerCharacters(defaultProvider),
        ...getProviderTriggerCharacters(bashProvider),
        ...getProviderTriggerCharacters(oneOffBashProvider),
      ]),
    ];
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): AutocompleteSuggestions | null | Promise<AutocompleteSuggestions | null> {
    if (this.isBashModeActive()) {
      return this.bashProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    const shouldUseOneOffBash = supportsShouldTriggerFileCompletion(this.oneOffBashProvider)
      && this.oneOffBashProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    if (shouldUseOneOffBash) {
      return this.oneOffBashProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    return this.defaultProvider?.getSuggestions(lines, cursorLine, cursorCol, options) ?? null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    if (this.isBashModeActive()) {
      return this.bashProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    const shouldUseOneOffBash = supportsShouldTriggerFileCompletion(this.oneOffBashProvider)
      && this.oneOffBashProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    if (shouldUseOneOffBash) {
      return this.oneOffBashProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    if (!this.defaultProvider) {
      return { lines, cursorLine, cursorCol };
    }
    return this.defaultProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    if (this.isBashModeActive()) {
      if (!supportsShouldTriggerFileCompletion(this.bashProvider)) {
        return true;
      }

      return this.bashProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    }

    const shouldUseOneOffBash = supportsShouldTriggerFileCompletion(this.oneOffBashProvider)
      && this.oneOffBashProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    if (shouldUseOneOffBash) {
      return true;
    }

    if (!this.defaultProvider || !supportsShouldTriggerFileCompletion(this.defaultProvider)) {
      return false;
    }

    return this.defaultProvider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

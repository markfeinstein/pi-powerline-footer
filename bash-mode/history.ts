import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { projectStorageKey } from "../project-key.ts";

interface PersistedHistoryEntry {
  command: string;
  cwd: string;
  timestamp: number;
}

const MAX_GLOBAL_HISTORY_BYTES = 1024 * 1024;
const ZSH_HISTORY_FILENAMES = new Set([".zsh_history"]);
const BASH_HISTORY_FILENAMES = new Set([".bash_history"]);
const FISH_HISTORY_FILENAMES = new Set(["fish_history"]);
const HISTORY_CACHE_LIMIT = 32;

type CachedHistory<T> = {
  key: string;
  value: T;
};

const globalHistoryCache = new Map<string, CachedHistory<string[]>>();

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function getHistoryDir(): string {
  return join(getHomeDir(), ".pi", "agent", "powerline-footer", "bash-history");
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function pathExistsOrIsDanglingSymlink(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    return !isFileNotFoundError(error);
  }
}

function isSafeWritableDirectoryPath(dirPath: string): boolean {
  try {
    return lstatSync(dirPath).isDirectory();
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function canWriteProjectHistoryPath(filePath: string): boolean {
  const historyDir = dirname(filePath);
  const powerlineDir = dirname(historyDir);
  const agentDir = dirname(powerlineDir);
  const piDir = dirname(agentDir);

  if (![piDir, agentDir, powerlineDir, historyDir].every(isSafeWritableDirectoryPath)) {
    return false;
  }

  if (!pathExistsOrIsDanglingSymlink(filePath)) {
    return true;
  }

  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveSafeGlobalHistoryPath(filePath: string, home: string, allowedFileNames?: ReadonlySet<string>): string | null {
  if (!existsSync(filePath)) return null;

  const linkStats = lstatSync(filePath);
  if (!linkStats.isFile() || linkStats.size > MAX_GLOBAL_HISTORY_BYTES) return null;

  const realHome = realpathSync(home);
  const realFilePath = realpathSync(filePath);
  if (!isPathInside(realHome, realFilePath)) return null;
  if (allowedFileNames && !allowedFileNames.has(basename(realFilePath))) return null;

  const stats = statSync(realFilePath);
  if (!stats.isFile() || stats.size > MAX_GLOBAL_HISTORY_BYTES) return null;
  return realFilePath;
}

function projectKey(cwd: string): string {
  return projectStorageKey(cwd);
}

function legacyProjectKey(cwd: string): string {
  return cwd.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[\\/]+/g, "-") || "root";
}

function projectHistoryPath(cwd: string): string {
  return join(getHistoryDir(), `${projectKey(cwd)}.json`);
}

function legacyProjectHistoryPath(cwd: string): string {
  return join(getHistoryDir(), `${legacyProjectKey(cwd)}.json`);
}

function projectHistoryPaths(cwd: string): string[] {
  const resolvedCwd = resolve(cwd);
  return Array.from(new Set([
    projectHistoryPath(cwd),
    legacyProjectHistoryPath(cwd),
    legacyProjectHistoryPath(resolvedCwd),
  ]));
}

function readHistoryFingerprint(filePath: string): string {
  const stats = statSync(filePath);
  return `${filePath}:${stats.size}:${stats.mtimeMs}`;
}

function memoizeHistory<T>(cache: Map<string, CachedHistory<T>>, key: string, value: T): T {
  cache.set(key, { key, value });
  if (cache.size > HISTORY_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
  return value;
}

function normalizePersistedEntries(value: unknown): PersistedHistoryEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: PersistedHistoryEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
    const timestamp = typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : 0;
    if (!command || !cwd || !Number.isFinite(timestamp)) continue;
    entries.push({ command, cwd, timestamp });
  }
  return entries;
}

export function readProjectHistory(cwd: string): PersistedHistoryEntry[] {
  const entries: PersistedHistoryEntry[] = [];

  for (const filePath of projectHistoryPaths(cwd)) {
    try {
      if (!canWriteProjectHistoryPath(filePath) || !lstatSync(filePath).isFile()) continue;

      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      entries.push(...normalizePersistedEntries((parsed as { entries?: unknown }).entries));
    } catch (error) {
      if (isFileNotFoundError(error)) continue;

      // Project history is a best-effort cache. If it is unreadable or malformed,
      // bash mode should keep working instead of failing command entry entirely.
      console.debug(`[powerline-footer] Failed to read bash project history from ${filePath}:`, error);
    }
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
}

export function appendProjectHistory(cwd: string, command: string, entryCwd: string): void {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) return;

  const existing = readProjectHistory(cwd);
  const next: PersistedHistoryEntry[] = [
    { command: normalizedCommand, cwd: entryCwd, timestamp: Date.now() },
    ...existing.filter((entry) => entry.command !== normalizedCommand),
  ].slice(0, 500);

  const filePath = projectHistoryPath(cwd);
  try {
    if (!canWriteProjectHistoryPath(filePath)) {
      console.debug(`[powerline-footer] Refusing to persist bash project history through unsafe path ${filePath}`);
      return;
    }

    mkdirSync(dirname(filePath), { recursive: true });
    if (!writeProjectHistoryAtomically(filePath, JSON.stringify({ version: 1, entries: next }, null, 2) + "\n")) {
      console.debug(`[powerline-footer] Refusing to persist bash project history through unsafe path ${filePath}`);
    }
  } catch (error) {
    // History persistence should never block a successful shell command from completing.
    console.debug(`[powerline-footer] Failed to persist bash project history to ${filePath}:`, error);
  }
}

// Write the history cache via a temp file + rename so an interrupted or
// concurrent write can never truncate/corrupt the existing JSON, and so a
// symlink swapped in after validation cannot redirect the write (rename
// replaces the symlink itself rather than following it). Returns false if the
// destination became a symlink after the earlier safety check; throws on other
// I/O errors so the caller can log them with context.
function writeProjectHistoryAtomically(filePath: string, contents: string): boolean {
  let tempPath = "";
  try {
    tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, contents, { flag: "wx" });
    try {
      if (lstatSync(filePath).isSymbolicLink()) {
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
    renameSync(tempPath, filePath);
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
    throw error;
  }
}

function parseZshHistoryLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith(":")) return trimmed;
  const parts = trimmed.split(";");
  if (parts.length < 2) return null;
  return parts.slice(1).join(";").trim() || null;
}

function hasUnclosedQuote(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (!inSingle && ch === "\\") {
      escaped = true;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
    }
  }

  return inSingle || inDouble;
}

function parseBashHistory(raw: string): string[] {
  const commands: string[] = [];
  let buffer = "";
  let continuationActive = false;
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trimEnd() ?? "";
    if (!trimmed) {
      if (buffer.trim() && continuationActive) {
        buffer += "\n";
        continue;
      }

      if (buffer.trim()) {
        commands.push(buffer.trim());
        buffer = "";
      }
      continuationActive = false;
      continue;
    }

    const hasTrailingBackslash = trimmed.endsWith("\\");
    const segment = hasTrailingBackslash ? trimmed.slice(0, -1).trimEnd() : trimmed.trim();
    const nextBuffer = buffer ? `${buffer}\n${segment}` : segment;
    const isContinuation = hasTrailingBackslash || hasUnclosedQuote(nextBuffer);
    buffer += buffer ? `\n${segment}` : segment;
    continuationActive = isContinuation;

    if (!isContinuation) {
      commands.push(buffer.trim());
      buffer = "";
      continuationActive = false;
    }
  }

  if (buffer.trim()) {
    commands.push(buffer.trim());
  }

  return commands;
}

function parseFishHistory(raw: string): string[] {
  const matches = raw.matchAll(/^\s*-\s*cmd:\s*(.+)$/gm);
  const commands: string[] = [];
  for (const match of matches) {
    const command = match[1]?.trim();
    if (command) commands.push(command);
  }
  return commands;
}

export function readGlobalShellHistory(shellPath: string): string[] {
  const shellName = basename(shellPath).toLowerCase();
  const home = getHomeDir();

  try {
    let filePath: string | null = null;
    let parse: (raw: string) => string[] = (raw) => parseBashHistory(raw).reverse();

    if (shellName.includes("zsh")) {
      const explicitHistfile = process.env.HISTFILE;
      filePath = resolveSafeGlobalHistoryPath(
        explicitHistfile || join(home, ".zsh_history"),
        home,
        explicitHistfile ? undefined : ZSH_HISTORY_FILENAMES,
      );
      parse = (raw) => raw.split("\n").map(parseZshHistoryLine).filter((entry): entry is string => Boolean(entry)).reverse();
    } else if (shellName.includes("fish")) {
      filePath = resolveSafeGlobalHistoryPath(join(home, ".local", "share", "fish", "fish_history"), home, FISH_HISTORY_FILENAMES);
      parse = (raw) => parseFishHistory(raw).reverse();
    } else {
      const explicitHistfile = process.env.HISTFILE;
      filePath = resolveSafeGlobalHistoryPath(
        explicitHistfile || join(home, ".bash_history"),
        home,
        explicitHistfile ? undefined : BASH_HISTORY_FILENAMES,
      );
    }

    if (!filePath) return [];
    const cacheKey = `${shellName}:${filePath}:${readHistoryFingerprint(filePath)}`;
    const cached = globalHistoryCache.get(shellPath);
    if (cached?.key === cacheKey) return cached.value;

    const parsed = parse(readFileSync(filePath, "utf8"));
    return memoizeHistory(globalHistoryCache, shellPath, parsed);
  } catch (error) {
    // Global shell history is optional recall data. If it is unavailable, shell predictions
    // should degrade to other sources instead of failing the editor.
    console.debug(`[powerline-footer] Failed to read global shell history for ${shellName}:`, error);
    return [];
  }
}

export function matchHistoryEntries(entries: string[], prefix: string, limit: number): string[] {
  const trimmedPrefix = prefix.trim();
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const rawEntry of entries) {
    const entry = rawEntry?.trim();
    if (!entry || seen.has(entry)) continue;
    if (trimmedPrefix && !entry.startsWith(trimmedPrefix)) continue;
    seen.add(entry);
    matches.push(entry);
    if (matches.length >= limit) break;
  }

  return matches;
}

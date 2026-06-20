import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  timestamp: number;
  failed?: boolean;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
  failed?: boolean;
}

export type GitPollingMode = "full" | "branch" | "off";

const CACHE_TTL_MS = 5_000; // Dirty status polling is async; explicit invalidations keep updates prompt.
const BRANCH_TTL_MS = 2_000; // Branch changes are explicitly invalidated after git-like commands.
const FAILED_CACHE_TTL_MS = 10_000; // Back off repeated polling in non-git/slow/erroring dirs
const MAX_GIT_STDOUT_BYTES = 512 * 1024;
const MAX_REALPATH_CACHE_ENTRIES = 256;
const cachedStatuses = new Map<string, CachedGitStatus>();
const cachedBranches = new Map<string, CachedBranch>();
const cachedRealpaths = new Map<string, string>();
type PendingGitFetch = { promise: Promise<void>; controller: AbortController };
const pendingFetches = new Map<string, PendingGitFetch>();
const pendingBranchFetches = new Map<string, PendingGitFetch>();
let invalidationCounter = 0; // Track invalidations to prevent stale updates
let branchInvalidationCounter = 0;
let gitStatusUpdateListener: (() => void) | null = null;

export function setGitStatusUpdateListener(listener: (() => void) | null): void {
  gitStatusUpdateListener = listener;
}

function notifyGitStatusUpdated(): void {
  try {
    gitStatusUpdateListener?.();
  } catch {
    // Git polling must never break rendering if a listener is stale.
  }
}

function sameStatus(a: CachedGitStatus | undefined, b: CachedGitStatus): boolean {
  return a?.staged === b.staged && a.unstaged === b.unstaged && a.untracked === b.untracked;
}

function isFresh(timestamp: number, now: number, failed?: boolean): boolean {
  return now - timestamp < (failed ? FAILED_CACHE_TTL_MS : CACHE_TTL_MS);
}

function isFreshBranch(timestamp: number, now: number, failed?: boolean): boolean {
  return now - timestamp < (failed ? FAILED_CACHE_TTL_MS : BRANCH_TTL_MS);
}

function cacheKey(cwd: string): string {
  const resolved = resolve(cwd);
  const cached = cachedRealpaths.get(resolved);
  if (cached) return cached;

  let key: string;
  try {
    key = realpathSync(resolved);
  } catch {
    key = resolved;
  }

  if (cachedRealpaths.size >= MAX_REALPATH_CACHE_ENTRIES) {
    cachedRealpaths.clear();
  }
  cachedRealpaths.set(resolved, key);
  return key;
}

/**
 * Parse git status --porcelain output
 * 
 * Format: XY filename
 * X = index status, Y = working tree status
 * ?? = untracked
 * Other X values = staged
 * Other Y values = unstaged
 */
function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    // X position (index/staged)
    if (x && x !== " " && x !== "?") {
      staged++;
    }

    // Y position (working tree/unstaged)
    if (y && y !== " ") {
      unstaged++;
    }
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], cwd: string, timeoutMs = 200, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcessByStdio<null, Readable, null> | null = null;
    let stdout = "";
    let resolved = false;

    const killProcessGroup = () => {
      if (!proc || proc.pid === undefined) return;
      try {
        if (process.platform !== "win32") {
          process.kill(-proc.pid, "SIGKILL");
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have already exited.
        }
      }
    };

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    const abortHandler = () => {
      killProcessGroup();
      finish(null);
    };

    const timeoutId = setTimeout(() => {
      killProcessGroup();
      finish(null);
    }, timeoutMs);

    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      proc = spawn("git", args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      if (Buffer.byteLength(stdout, "utf8") > MAX_GIT_STDOUT_BYTES) {
        killProcessGroup();
        finish(null);
      }
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });
  });
}

/**
 * Fetch current git branch asynchronously.
 * For detached HEAD, returns the short commit SHA (matches provider's "detached" behavior).
 */
async function fetchGitBranch(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"], cwd, 200, signal);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"], cwd, 200, signal);
  return sha ? `${sha} (detached)` : "detached";
}

/**
 * Fetch git status asynchronously
 */
async function fetchGitStatus(cwd: string, signal?: AbortSignal): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--porcelain"], cwd, 500, signal);
  if (output === null) return null;
  return parseGitStatusOutput(output);
}

/**
 * Get the current git branch with caching.
 * Falls back to provider branch if our cache is empty.
 */
export function getCurrentBranch(providerBranch: string | null, cwd = process.cwd()): string | null {
  const now = Date.now();
  const key = cacheKey(cwd);
  const cachedBranch = cachedBranches.get(key) ?? null;

  // Return cached if fresh
  if (cachedBranch && isFreshBranch(cachedBranch.timestamp, now, cachedBranch.failed)) {
    return cachedBranch.failed && providerBranch ? providerBranch : cachedBranch.branch;
  }

  // Trigger background fetch if not already pending
  if (!pendingBranchFetches.has(key)) {
    const fetchId = branchInvalidationCounter;
    const controller = new AbortController();
    const pendingBranchFetch = fetchGitBranch(key, controller.signal).then((result) => {
      // Cache result if no invalidation happened (including null for non-git dirs)
      if (fetchId === branchInvalidationCounter) {
        const previous = cachedBranches.get(key);
        cachedBranches.set(key, {
          branch: result,
          timestamp: Date.now(),
          failed: result === null,
        });
        if (!previous || previous.branch !== result) {
          notifyGitStatusUpdated();
        }
      }
      if (pendingBranchFetches.get(key)?.promise === pendingBranchFetch) {
        pendingBranchFetches.delete(key);
      }
    });
    pendingBranchFetches.set(key, { promise: pendingBranchFetch, controller });
  }

  // Return stale cache while refreshing; only use provider before first fetch
  return cachedBranch ? cachedBranch.branch : providerBranch;
}

/**
 * Get git status with caching.
 * Returns cached value if within TTL, otherwise triggers async fetch.
 * This is designed for synchronous render() calls - returns last known value
 * while refreshing in background.
 */
export function getGitStatus(providerBranch: string | null, pollingMode: GitPollingMode = "full", cwd = process.cwd()): GitStatus {
  const now = Date.now();
  const key = cacheKey(cwd);
  const branch = pollingMode === "off" ? providerBranch : getCurrentBranch(providerBranch, key);

  if (pollingMode !== "full") {
    return { branch, staged: 0, unstaged: 0, untracked: 0 };
  }

  const cachedStatus = cachedStatuses.get(key) ?? null;

  // Return cached if fresh
  if (cachedStatus && isFresh(cachedStatus.timestamp, now, cachedStatus.failed)) {
    return { 
      branch, 
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  // Trigger background fetch if not already pending
  if (!pendingFetches.has(key)) {
    const fetchId = invalidationCounter; // Capture current counter
    const controller = new AbortController();
    const pendingFetch = fetchGitStatus(key, controller.signal).then((result) => {
      // Cache result if no invalidation happened (including null for non-git dirs)
      if (fetchId === invalidationCounter) {
        const nextStatus = result
          ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked, timestamp: Date.now(), failed: false }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: Date.now(), failed: true };
        const previous = cachedStatuses.get(key);
        cachedStatuses.set(key, nextStatus);
        if (!sameStatus(previous, nextStatus)) {
          notifyGitStatusUpdated();
        }
      }
      if (pendingFetches.get(key)?.promise === pendingFetch) {
        pendingFetches.delete(key);
      }
    });
    pendingFetches.set(key, { promise: pendingFetch, controller });
  }

  // Return last cached or empty
  if (cachedStatus) {
    return { 
      branch, 
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  return { branch, staged: 0, unstaged: 0, untracked: 0 };
}

/**
 * Force refresh git status (call when you know files changed)
 */
export function invalidateGitStatus(): void {
  invalidationCounter++; // Increment before aborting so aborted fetches cannot cache failures.
  cachedStatuses.clear();
  for (const pending of pendingFetches.values()) {
    pending.controller.abort();
  }
  pendingFetches.clear();
  cachedRealpaths.clear();
}

/**
 * Force refresh git branch (call when you know branch might have changed)
 */
export function invalidateGitBranch(): void {
  branchInvalidationCounter++;
  cachedBranches.clear();
  for (const pending of pendingBranchFetches.values()) {
    pending.controller.abort();
  }
  pendingBranchFetches.clear();
  cachedRealpaths.clear();
}

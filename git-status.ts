import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

export type GitPollingMode = "full" | "branch" | "off";

const CACHE_TTL_MS = 1000; // 1 second for file status
const BRANCH_TTL_MS = 500; // Shorter TTL so branch updates quickly after invalidation
const cachedStatuses = new Map<string, CachedGitStatus>();
const cachedBranches = new Map<string, CachedBranch>();
const pendingFetches = new Map<string, Promise<void>>();
const pendingBranchFetches = new Map<string, Promise<void>>();
let invalidationCounter = 0; // Track invalidations to prevent stale updates
let branchInvalidationCounter = 0;

function cacheKey(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
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

function runGit(args: string[], cwd: string, timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

/**
 * Fetch current git branch asynchronously.
 * For detached HEAD, returns the short commit SHA (matches provider's "detached" behavior).
 */
async function fetchGitBranch(cwd: string): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return sha ? `${sha} (detached)` : "detached";
}

/**
 * Fetch git status asynchronously
 */
async function fetchGitStatus(cwd: string): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--porcelain"], cwd, 500);
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
  if (cachedBranch && now - cachedBranch.timestamp < BRANCH_TTL_MS) {
    return cachedBranch.branch;
  }

  // Trigger background fetch if not already pending
  if (!pendingBranchFetches.has(key)) {
    const fetchId = branchInvalidationCounter;
    const pendingBranchFetch = fetchGitBranch(key).then((result) => {
      // Cache result if no invalidation happened (including null for non-git dirs)
      if (fetchId === branchInvalidationCounter) {
        cachedBranches.set(key, {
          branch: result,
          timestamp: Date.now(),
        });
      }
      pendingBranchFetches.delete(key);
    });
    pendingBranchFetches.set(key, pendingBranchFetch);
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
  if (cachedStatus && now - cachedStatus.timestamp < CACHE_TTL_MS) {
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
    const pendingFetch = fetchGitStatus(key).then((result) => {
      // Cache result if no invalidation happened (including null for non-git dirs)
      if (fetchId === invalidationCounter) {
        cachedStatuses.set(key, result
          ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked, timestamp: Date.now() }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: Date.now() });
      }
      pendingFetches.delete(key);
    });
    pendingFetches.set(key, pendingFetch);
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
  cachedStatuses.clear();
  invalidationCounter++; // Increment to invalidate any pending fetches
}

/**
 * Force refresh git branch (call when you know branch might have changed)
 */
export function invalidateGitBranch(): void {
  cachedBranches.clear();
  branchInvalidationCounter++;
}

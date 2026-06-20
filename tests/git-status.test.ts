import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { getGitStatus, invalidateGitBranch, invalidateGitStatus, setGitStatusUpdateListener } from "../git-status.ts";
import { getPreset } from "../presets.ts";

test("git status supports disabling extension git polling", () => {
  assert.deepEqual(getGitStatus("main", "off"), {
    branch: "main",
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });
});

test("minimal preset uses branch-only git polling by default", () => {
  assert.equal(getPreset("minimal").segmentOptions?.git?.polling, "branch");
});

test("git status cache is isolated per cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "powerline-git-cache-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  initRepo(repoA, "alpha");
  initRepo(repoB, "beta");
  writeFileSync(join(repoA, "a.txt"), "a\n");

  invalidateGitStatus();
  invalidateGitBranch();

  const statusA = await waitForGitStatus(repoA, (status) => status.branch === "alpha" && status.untracked === 1);
  assert.equal(statusA.branch, "alpha");
  assert.equal(statusA.untracked, 1);

  const firstStatusB = getGitStatus(null, "full", repoB);
  assert.notEqual(firstStatusB.branch, "alpha");
  assert.equal(firstStatusB.untracked, 0);

  const statusB = await waitForGitStatus(repoB, (status) => status.branch === "beta" && status.untracked === 0);
  assert.equal(statusB.branch, "beta");
  assert.equal(statusB.untracked, 0);
});

test("git status cache is shared across symlinked repo paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "powerline-git-symlink-"));
  const repo = join(root, "repo");
  const link = join(root, "repo-link");
  mkdirSync(repo);
  initRepo(repo, "main");
  symlinkSync(repo, link, "dir");
  writeFileSync(join(repo, "a.txt"), "a\n");

  invalidateGitStatus();
  invalidateGitBranch();

  const realStatus = await waitForGitStatus(repo, (status) => status.branch === "main" && status.untracked === 1);
  assert.equal(realStatus.untracked, 1);

  const linkedStatus = getGitStatus(null, "full", link);
  assert.equal(linkedStatus.branch, "main");
  assert.equal(linkedStatus.untracked, 1);
});

test("git status counts staged, unstaged, and untracked changes together", async () => {
  const repo = mkdtempSync(join(tmpdir(), "powerline-git-mixed-"));
  initRepo(repo, "main");
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "init");

  // tracked.txt modified but not staged -> unstaged
  writeFileSync(join(repo, "tracked.txt"), "v2\n");
  // staged.txt newly added -> staged
  writeFileSync(join(repo, "staged.txt"), "s\n");
  git(repo, "add", "staged.txt");
  // untracked.txt never added -> untracked
  writeFileSync(join(repo, "untracked.txt"), "u\n");

  invalidateGitStatus();
  invalidateGitBranch();

  const status = await waitForGitStatus(
    repo,
    (s) => s.staged === 1 && s.unstaged === 1 && s.untracked === 1,
  );
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 1);
  assert.equal(status.untracked, 1);
});

test("git status ignores oversized porcelain output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-git-huge-output-"));
  const binDir = join(cwd, "bin");
  mkdirSync(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, "#!/bin/sh\nif [ \"$1\" = \"status\" ]; then yes ' M huge-file' | head -n 80000; exit 0; fi\nexit 1\n", "utf8");
  chmodSync(gitPath, 0o700);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  try {
    invalidateGitStatus();
    invalidateGitBranch();
    getGitStatus(null, "full", cwd);
    await new Promise((resolve) => setTimeout(resolve, 900));

    const status = getGitStatus(null, "full", cwd);
    assert.equal(status.staged, 0);
    assert.equal(status.unstaged, 0);
    assert.equal(status.untracked, 0);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("git status timeout kills helper process groups", async (t) => {
  if (process.platform === "win32") {
    t.skip("process group signaling differs on Windows");
    return;
  }

  const cwd = mkdtempSync(join(tmpdir(), "powerline-git-process-group-"));
  const binDir = join(cwd, "bin");
  mkdirSync(binDir, { recursive: true });
  const childPidPath = join(cwd, "child.pid");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = "branch" ]; then echo main; exit 0; fi
if [ "$1" = "status" ]; then
  sleep 5 &
  echo $! > ${quoteForShell(childPidPath)}
  sleep 5
  exit 0
fi
exit 1
`, "utf8");
  chmodSync(gitPath, 0o700);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  let childPid = 0;
  try {
    invalidateGitStatus();
    invalidateGitBranch();
    getGitStatus(null, "full", cwd);

    const pidDeadline = Date.now() + 500;
    while (Date.now() < pidDeadline && childPid === 0) {
      childPid = readStatusCount(childPidPath);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(childPid > 0, "expected fake git to start a helper child");

    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && isProcessAlive(childPid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessAlive(childPid), false, "timed-out git helper child should be killed");
  } finally {
    if (childPid > 0 && isProcessAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("git status invalidation starts a fresh fetch when an old one is pending", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-git-pending-invalidation-"));
  const binDir = join(cwd, "bin");
  mkdirSync(binDir, { recursive: true });
  const countPath = join(cwd, "status-count");
  const firstPidPath = join(cwd, "first-status.pid");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, `#!/bin/sh
if [ "$1" = "branch" ]; then echo main; exit 0; fi
if [ "$1" = "status" ]; then
  count=$(cat ${quoteForShell(countPath)} 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > ${quoteForShell(countPath)}
  if [ "$count" = "1" ]; then echo $$ > ${quoteForShell(firstPidPath)}; sleep 5; exit 0; fi
  echo '?? fresh-file'
  exit 0
fi
exit 1
`, "utf8");
  chmodSync(gitPath, 0o700);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  try {
    invalidateGitStatus();
    invalidateGitBranch();
    getGitStatus(null, "full", cwd);
    const firstDeadline = Date.now() + 500;
    while (Date.now() < firstDeadline && (readStatusCount(countPath) < 1 || readStatusCount(firstPidPath) < 1)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const firstPid = readStatusCount(firstPidPath);
    assert.ok(firstPid > 0, "expected first git status fetch to record its pid before invalidation");

    invalidateGitStatus();
    getGitStatus(null, "full", cwd);

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && readStatusCount(countPath) < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(readStatusCount(countPath) >= 2, `expected a second git status fetch after invalidation, got count ${readStatusCount(countPath)}`);

    if (process.platform !== "win32") {
      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline && firstPid > 0 && isProcessAlive(firstPid)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(isProcessAlive(firstPid), false, "invalidated git status fetch should be aborted");
    }
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("git status update listener fires after async cache refresh", async () => {
  const repo = mkdtempSync(join(tmpdir(), "powerline-git-listener-"));
  initRepo(repo, "main");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  let updates = 0;
  setGitStatusUpdateListener(() => {
    updates += 1;
  });

  try {
    invalidateGitStatus();
    invalidateGitBranch();
    getGitStatus(null, "full", repo);

    const deadline = Date.now() + 2000;
    while (updates === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(updates > 0, "expected async git refresh to request a repaint");
  } finally {
    setGitStatusUpdateListener(null);
  }
});

test("branch-only polling reports branch without dirty counts", async () => {
  const repo = mkdtempSync(join(tmpdir(), "powerline-git-branch-only-"));
  initRepo(repo, "main");
  writeFileSync(join(repo, "untracked.txt"), "u\n");

  invalidateGitStatus();
  invalidateGitBranch();

  const status = await waitForGitStatus(repo, (s) => s.branch === "main", "branch");
  assert.equal(status.branch, "main");
  assert.equal(status.staged, 0);
  assert.equal(status.unstaged, 0);
  assert.equal(status.untracked, 0);
});

test("git branch falls back to short sha for detached HEAD", async () => {
  const repo = mkdtempSync(join(tmpdir(), "powerline-git-detached-"));
  initRepo(repo, "main");
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "init");
  git(repo, "checkout", "--detach", "HEAD");

  invalidateGitStatus();
  invalidateGitBranch();

  const status = await waitForGitStatus(repo, (s) => /[0-9a-f]+ \(detached\)/.test(s.branch ?? ""), "branch");
  assert.match(status.branch ?? "", /^[0-9a-f]+ \(detached\)$/);
});

test("git status counts a staged rename as a single staged change", async () => {
  const repo = mkdtempSync(join(tmpdir(), "powerline-git-rename-"));
  initRepo(repo, "main");
  writeFileSync(join(repo, "old.txt"), "contents that stay identical after rename\n");
  git(repo, "add", "old.txt");
  git(repo, "commit", "-m", "init");
  git(repo, "mv", "old.txt", "new.txt");

  invalidateGitStatus();
  invalidateGitBranch();

  const status = await waitForGitStatus(
    repo,
    (s) => s.staged === 1 && s.untracked === 0,
  );
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 0);
  assert.equal(status.untracked, 0);
});

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readStatusCount(filePath: string): number {
  try {
    return Number.parseInt(readFileSync(filePath, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function initRepo(cwd: string, branch: string): void {
  const result = spawnSync("git", ["init", "-b", branch], { cwd, stdio: "ignore" });
  assert.equal(result.status, 0, `git init failed for ${cwd}`);
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}`);
}

async function waitForGitStatus(
  cwd: string,
  predicate: (status: ReturnType<typeof getGitStatus>) => boolean,
  pollingMode: Parameters<typeof getGitStatus>[1] = "full",
): Promise<ReturnType<typeof getGitStatus>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = getGitStatus(null, pollingMode, cwd);
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const status = getGitStatus(null, pollingMode, cwd);
  assert.fail(`timed out waiting for git status in ${cwd}: ${JSON.stringify(status)}`);
}

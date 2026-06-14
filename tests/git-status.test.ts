import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getGitStatus, invalidateGitBranch, invalidateGitStatus } from "../git-status.ts";

test("git status supports disabling extension git polling", () => {
  assert.deepEqual(getGitStatus("main", "off"), {
    branch: "main",
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });
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

async function waitForGitStatus(cwd: string, predicate: (status: ReturnType<typeof getGitStatus>) => boolean): Promise<ReturnType<typeof getGitStatus>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = getGitStatus(null, "full", cwd);
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const status = getGitStatus(null, "full", cwd);
  assert.fail(`timed out waiting for git status in ${cwd}: ${JSON.stringify(status)}`);
}

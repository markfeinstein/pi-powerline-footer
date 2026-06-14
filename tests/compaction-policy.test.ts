import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCompactionPolicyEnabled } from "../index.ts";

test("readCompactionPolicyEnabled ignores malformed policy files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const policyPath = join(cwd, "policy.json");

  writeFileSync(policyPath, "not json\n");

  assert.equal(readCompactionPolicyEnabled(policyPath), undefined);
});

test("readCompactionPolicyEnabled returns configured boolean policy values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const policyPath = join(cwd, "policy.json");

  writeFileSync(policyPath, JSON.stringify({ enabled: true }), "utf-8");
  assert.equal(readCompactionPolicyEnabled(policyPath), true);

  writeFileSync(policyPath, JSON.stringify({ enabled: false }), "utf-8");
  assert.equal(readCompactionPolicyEnabled(policyPath), false);
});

test("readCompactionPolicyEnabled ignores oversized policy files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const policyPath = join(cwd, "policy.json");

  writeFileSync(policyPath, "x".repeat(64 * 1024 + 1), "utf-8");

  assert.equal(readCompactionPolicyEnabled(policyPath), undefined);
});

test("readCompactionPolicyEnabled ignores symlinked policy files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const targetPath = join(cwd, "target-policy.json");
  const policyPath = join(cwd, "policy.json");

  writeFileSync(targetPath, JSON.stringify({ enabled: false }), "utf-8");
  symlinkSync(targetPath, policyPath);

  assert.equal(readCompactionPolicyEnabled(policyPath), undefined);
});

test("readCompactionPolicyEnabled ignores policy files under symlinked parent directories", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const targetDir = join(cwd, "target-pi");
  const policyDir = join(cwd, ".pi");
  const policyPath = join(policyDir, "compaction-policy.json");

  mkdirSync(targetDir);
  writeFileSync(join(targetDir, "compaction-policy.json"), JSON.stringify({ enabled: false }), "utf-8");
  symlinkSync(targetDir, policyDir, "dir");

  assert.equal(readCompactionPolicyEnabled(policyPath), undefined);
});

test("readCompactionPolicyEnabled ignores policy files under symlinked ancestor directories", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const targetPiDir = join(cwd, "target-pi");
  const targetAgentDir = join(targetPiDir, "agent");
  const piDir = join(cwd, ".pi");
  const policyPath = join(piDir, "agent", "compaction-policy.json");

  mkdirSync(targetAgentDir, { recursive: true });
  writeFileSync(join(targetAgentDir, "compaction-policy.json"), JSON.stringify({ enabled: false }), "utf-8");
  symlinkSync(targetPiDir, piDir, "dir");

  assert.equal(readCompactionPolicyEnabled(policyPath), undefined);
});

test("readCompactionPolicyEnabled allows policy files under symlinked project roots", () => {
  const cwd = mkdtempSync(join(tmpdir(), "powerline-footer-compaction-"));
  const projectDir = join(cwd, "project");
  const linkedProjectDir = join(cwd, "linked-project");
  const policyDir = join(projectDir, ".pi");
  const policyPath = join(linkedProjectDir, ".pi", "compaction-policy.json");

  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, "compaction-policy.json"), JSON.stringify({ enabled: true }), "utf-8");
  symlinkSync(projectDir, linkedProjectDir, "dir");

  assert.equal(readCompactionPolicyEnabled(policyPath), true);
});
